/**
 * `overbridge cleanup`: read what `cleanup-scan.ts` needs to know about every workspace and orphan folder (git, GitHub
 * and the work-item provider) and print each one's finding. It reports only; `overbridge rm` does the removing.
 */
import { type AgentState, AT_REST, readAgentState } from "./agent-state";
import { classify, CleanupReason, CleanupVerdict, type Finding, type ItemFact, type PrFact, PrState, type RepoFacts, type WorkspaceFacts } from "./cleanup-scan";
import { table } from "./commands";
import { getRepo, loadRepos } from "./config";
import * as git from "./git";
import { isOrchestrationTab } from "./orchestration";
import { orphanNames, strayFiles, worktreesIn } from "./orphan";
import { barePath, worktreePath, wsDir } from "./paths";
import { providerFor } from "./pm";
import type { Provider } from "./pm/provider";
import { loadRepoConfig } from "./project-config";
import { cachedValue } from "./value-cache";
import { localStacks, stackOf } from "./stack";
import { type Claim, isRemoving, readState, type State, TASK_BRANCH_PREFIX } from "./state";
import { errorMessage, log, naturalSort, type RunResult, run } from "./util";
import { existsSync } from "node:fs";
import { basename } from "node:path";

/** Every outside read the scan makes, so tests need no git, `gh` or provider. */
export interface GatherDeps {
  exec: (cmd: string[], cwd: string) => RunResult;
  /** The repo's work-item provider, or undefined when it has none or its config does not load. */
  provider: (repo: string, wt: string) => Provider | undefined;
  /** The remote default branch, such as `origin/main`. */
  defaultRef: (repo: string) => string;
  agent: (ws: string) => AgentState | undefined;
  /** Whether `branch` is a layer of a gh stack with more than one layer. */
  stacked: (repo: string, branch: string | undefined) => boolean;
  strayFiles: (ws: string, repos: readonly string[]) => string[];
}

/** A PR fact read by the scan stays valid this long, so a scan right after the sweep reuses what it read. */
export const PR_FACT_TTL_MS = 60_000;

/** The `gh` reads that name a PR's state; nothing else is cached (git facts always come straight from git). */
const isPrRead = (cmd: string[]) => cmd[0] === "gh" && ((cmd[1] === "pr" && (cmd[2] === "view" || cmd[2] === "list")) || (cmd[1] === "api" && /\/commits\/[^/]+\/pulls$/.test(cmd[2] ?? "")));

/** `run`, with a PR read answered from `values.json` while it is under the TTL. A failed read is never cached or served stale. */
export function cachedExec(exec: (cmd: string[], cwd: string) => RunResult, now: () => number = Date.now): (cmd: string[], cwd: string) => RunResult {
  return (cmd, cwd) => {
    if (!isPrRead(cmd)) return exec(cmd, cwd);
    let failed: RunResult | undefined;
    const out = cachedValue(
      `scan:${cwd}:${cmd.join(" ")}`,
      PR_FACT_TTL_MS,
      () => {
        const r = exec(cmd, cwd);
        if (r.ok) return r.stdout;
        failed = r;
        return undefined;
      },
      now(),
      false,
    );
    return out !== undefined ? { ok: true, code: 0, stdout: out, stderr: "" } : (failed ?? exec(cmd, cwd));
  };
}

const defaultDeps = (): GatherDeps => ({
  exec: cachedExec((cmd, cwd) => run(cmd, { cwd })),
  provider: (repo, wt) => {
    try {
      const pm = loadRepoConfig(wt, repo).projectManagement;
      return pm ? providerFor(pm, wt) : undefined;
    } catch {
      return undefined;
    }
  },
  defaultRef: (repo) => `origin/${git.defaultBranch(getRepo(repo))}`,
  agent: (ws) => readAgentState(ws),
  stacked: (repo, branch) => {
    try {
      return (stackOf(localStacks(repo), branch)?.layers.length ?? 0) > 1;
    } catch {
      return false;
    }
  },
  strayFiles: (ws, repos) => strayFiles(wsDir(ws), repos),
});

const PR_FIELDS = "number,state,headRefName,url,title";
const PR_SEARCH_LIMIT = 30;
const GH_STATES: Record<string, PrState> = { OPEN: PrState.Open, MERGED: PrState.Merged, CLOSED: PrState.Closed };

interface RawPr {
  number?: number;
  state?: string;
  headRefName?: string;
  url?: string;
  title?: string;
}

function prFact(raw: RawPr, provider: Provider | undefined): PrFact | undefined {
  const state = GH_STATES[raw.state ?? ""];
  if (raw.number === undefined || !state) {
    return undefined;
  }
  const branch = raw.headRefName ?? "";
  const item = provider?.idFromBranch(branch) ?? provider?.idFromBranch(raw.title ?? "");
  return { number: raw.number, state, branch, url: raw.url ?? "", ...(item ? { item } : {}) };
}

const parse = <T>(json: string, fallback: T): T => {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
};

/** A read's value plus what went wrong getting it. */
interface Read<T> {
  value: T;
  problems: string[];
}
const read = <T>(value: T, ...problems: string[]): Read<T> => ({ value, problems });

/** The PR `selector` (a number or a branch) names. A branch with no PR is not a problem; a PR number that can't be read is. */
function readPr(selector: string, wt: string, deps: GatherDeps, provider: Provider | undefined): Read<PrFact | undefined> {
  const r = deps.exec(["gh", "pr", "view", selector, "--json", PR_FIELDS], wt);
  const pr = r.ok ? prFact(parse<RawPr>(r.stdout, {}), provider) : undefined;
  const numbered = /^\d+$/.test(selector);
  return pr || !numbered ? read(pr) : read(pr, `PR #${selector} could not be read: ${r.stderr || "gh printed nothing usable"}`);
}

/** Every PR whose branch or title names item `id`, whatever branch it came from. */
function readItemPrs(id: string, wt: string, deps: GatherDeps, provider: Provider): Read<PrFact[]> {
  const r = deps.exec(["gh", "pr", "list", "--state", "all", "--search", id, "--limit", String(PR_SEARCH_LIMIT), "--json", PR_FIELDS], wt);
  if (!r.ok) {
    return read([], `PRs for ${id} could not be listed: ${r.stderr || r.stdout}`);
  }
  const prs = parse<RawPr[]>(r.stdout, []).flatMap((raw) => prFact(raw, provider) ?? []);
  return read(prs.filter((pr) => pr.item === id));
}

/** Whether commit `sha` is part of a merged PR: a squash merge leaves the branch's commits on no remote branch. */
function inMergedPr(sha: string, wt: string, deps: GatherDeps): boolean {
  const r = deps.exec(["gh", "api", `repos/{owner}/{repo}/commits/${sha}/pulls`], wt);
  return r.ok && parse<{ merged_at?: string | null }[]>(r.stdout, []).some((pr) => !!pr.merged_at);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Stash entries made on `branch`. Stashes belong to the bare repo, so every worktree lists them all. */
function stashesOn(branch: string | undefined, wt: string, deps: GatherDeps): number {
  if (!branch) {
    return 0;
  }
  const made = new RegExp(`^(?:WIP on|On) ${escapeRegex(branch)}:`);
  return deps
    .exec(["git", "-C", wt, "stash", "list", "--format=%gs"], wt)
    .stdout.split("\n")
    .filter((line) => made.test(line)).length;
}

/** The local commit facts of one worktree. A git failure reads as unpushed work. */
function commitFacts(repo: string, wt: string, deps: GatherDeps): Read<Pick<RepoFacts, "head" | "dirty" | "ahead" | "unpushed">> {
  const gitIn = (args: string[]) => deps.exec(["git", "-C", wt, ...args], wt);
  const head = gitIn(["branch", "--show-current"]).stdout || undefined;
  const status = gitIn(["status", "--porcelain"]);
  const aheadRun = gitIn(["rev-list", "--count", `${deps.defaultRef(repo)}..HEAD`]);
  const offRemote = gitIn(["rev-list", "--count", "HEAD", "--not", "--remotes"]);
  const base = { ...(head ? { head } : {}), dirty: !status.ok || status.stdout !== "" };
  if (!status.ok || !aheadRun.ok || !offRemote.ok || !/^\d+$/.test(aheadRun.stdout)) {
    return read({ ...base, ahead: 1, unpushed: true }, `${repo}: git could not read the worktree at ${wt}`);
  }
  const sha = gitIn(["rev-parse", "HEAD"]).stdout;
  const unpushed = offRemote.stdout !== "0" && !inMergedPr(sha, wt, deps);
  return read({ ...base, ahead: Number(aheadRun.stdout), unpushed });
}

function repoFacts(repo: string, wt: string, claim: Claim, itemId: string | undefined, provider: Provider | undefined, deps: GatherDeps): Read<RepoFacts> {
  const commits = commitFacts(repo, wt, deps);
  const selector = claim.pr !== undefined ? String(claim.pr) : claim.branch;
  const pr = selector ? readPr(selector, wt, deps, provider) : read(undefined);
  const searched = itemId && provider && pr.value?.state !== PrState.Merged ? readItemPrs(itemId, wt, deps, provider) : read([]);
  const facts: RepoFacts = {
    repo,
    ...(claim.branch ? { claim: claim.branch } : {}),
    ...commits.value,
    task: claim.branch?.startsWith(TASK_BRANCH_PREFIX) === true,
    stacked: deps.stacked(repo, claim.branch),
    stashes: stashesOn(commits.value.head ?? claim.branch, wt, deps),
    ...(pr.value ? { pr: pr.value } : {}),
    itemPrs: searched.value.filter((found) => found.number !== pr.value?.number),
  };
  return read(facts, ...commits.problems, ...pr.problems, ...searched.problems);
}

/** The item a workspace name stands for: the id the provider would name this workspace after. */
export function namedItem(ws: string, repo: string, provider: Provider): string | undefined {
  const candidates = [provider.idFromBranch(ws), /(\d+)$/.exec(ws)?.[1]].flatMap((id) => id ?? []);
  return candidates.find((id) => {
    try {
      return provider.workspaceName(id, repo) === ws;
    } catch {
      return false;
    }
  });
}

/** What the scan needs to find a workspace's worktrees: its repos and their claims. */
export interface Target {
  ws: string;
  orphan: boolean;
  repos: { repo: string; wt: string; claim: Claim }[];
}

/** Read everything `classify` needs about one workspace or orphan folder. */
export function gatherFacts(target: Target, deps: GatherDeps): WorkspaceFacts {
  const { ws, orphan } = target;
  const withProvider = target.repos.flatMap((r) => {
    const provider = deps.provider(r.repo, r.wt);
    return provider ? [{ ...r, provider }] : [];
  });
  const first = withProvider[0];
  const provider = first?.provider;
  const claimed = withProvider.find((r) => r.claim.branch);
  const itemId = claimed?.claim.branch ? claimed.provider.idFromBranch(claimed.claim.branch) : undefined;
  const namedId = first ? namedItem(ws, first.repo, first.provider) : undefined;
  const fact = (id: string | undefined): ItemFact | undefined => {
    if (!id || !provider) {
      return undefined;
    }
    const status = provider.status(id);
    return { id, ...(status ? { status } : {}) };
  };
  const item = fact(itemId);
  const named = namedId === itemId ? item : fact(namedId);
  const repos = target.repos.map((r) => repoFacts(r.repo, r.wt, r.claim, itemId ?? namedId, deps.provider(r.repo, r.wt), deps));
  const agent = orphan ? undefined : deps.agent(ws);
  return {
    ws,
    orphan,
    repos: repos.map((r) => r.value),
    ...(item ? { item } : {}),
    ...(named ? { named } : {}),
    ...(agent ? { agent } : {}),
    agentAtRest: AT_REST.has(agent),
    strayFiles: deps.strayFiles(ws, target.repos.map((r) => basename(r.wt))),
    problems: repos.flatMap((r) => r.problems),
  };
}

/** Every workspace in state that is not an orchestration tab or already being removed, then every orphan folder. */
export function targets(state: State): Target[] {
  const tracked = Object.entries(state.workspaces)
    .filter(([ws, w]) => !isOrchestrationTab(ws) && !isRemoving(w))
    .sort(([a], [b]) => naturalSort(a, b))
    .map(([ws, w]): Target => ({ ws, orphan: false, repos: Object.entries(w.repos).map(([repo, claim]) => ({ repo, wt: worktreePath(ws, repo), claim })) }));
  const orphans = orphanNames(state).map((ws): Target => ({ ws, orphan: true, repos: worktreesIn(ws).map((w) => ({ repo: w.repo, wt: w.path, claim: {} })) }));
  return [...tracked, ...orphans];
}

/** A workspace whose facts could not be read is kept, with the reason. */
const unreadable = (target: Target, error: unknown): Finding => ({
  ws: target.ws,
  orphan: target.orphan,
  repos: [],
  agentAtRest: false,
  strayFiles: [],
  problems: [errorMessage(error)],
  verdict: CleanupVerdict.Keep,
  reason: CleanupReason.Unreadable,
  blockers: [],
  summary: `could not be read: ${errorMessage(error)}`,
});

/** One finding per workspace and orphan. Each is read in its own guard, so one bad workspace never hides the rest. */
export function scan(deps: GatherDeps = defaultDeps(), state: State = readState()): Finding[] {
  return targets(state).map((target) => {
    try {
      return classify(gatherFacts(target, deps));
    } catch (e) {
      return unreadable(target, e);
    }
  });
}

/** Whether `--no-fetch` was passed: the scan then trusts the remote refs already on disk. */
export const Fetch = { Yes: "yes", No: "no" } as const;
export type Fetch = (typeof Fetch)[keyof typeof Fetch];

export const Format = { Table: "table", Json: "json" } as const;
export type Format = (typeof Format)[keyof typeof Format];

/** `overbridge cleanup [--json] [--no-fetch]`: print every finding. Nothing is removed. */
export function cleanup(format: Format, fetch: Fetch) {
  if (fetch === Fetch.Yes) {
    Object.values(loadRepos())
      .filter((spec) => existsSync(barePath(spec.name)))
      .forEach((spec) => {
        try {
          git.fetch(spec);
        } catch (e) {
          log(`${spec.name}: fetch failed, using the refs on disk: ${errorMessage(e)}`);
        }
      });
  }
  const findings = scan();
  if (format === Format.Json) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }
  table(
    ["ws", "verdict", "reason", "blockers", ""],
    findings.map((f) => [f.orphan ? `${f.ws} (orphan)` : f.ws, f.verdict, f.reason, [...new Set(f.blockers.map((b) => b.kind))].join(","), f.summary]),
  );
  findings.flatMap((f) => f.problems.map((p) => `${f.ws}: ${p}`)).forEach(log);
}
