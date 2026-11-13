import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { AppStatus, appAvailable, appStatus, appUrl, readRecord } from "./apps";
import { readAgentState, sessionEndedForGood } from "./agent-state";
import { getRepo } from "./config";
import * as git from "./git";
import { isOrchestrationTab } from "./orchestration";
import { metaDir, wsDir, worktreePath } from "./paths";
import { providerFor, refreshTitle } from "./pm";
import type { Provider } from "./pm/provider";
import { type AppSpec, type ButtonSpec, type Ide, loadRepoConfig, type ProjectManagement } from "./project-config";
import { getWorkspace, isTaskClaim, readState } from "./state";
import { boxBottom, boxRow, boxTop, type Color, COLORS, colorize, fit, inverse, textWidth } from "./term";
import { parseUnresolved, REVIEWER_LOOK, type ReviewerStatus, type ReviewerView, reviewerLabel, reviewerStatuses, threadsCommand } from "./reviewers";
import { stackOf, localStacks } from "./stack";
import { describeValue, errorMessage, isRecord, run } from "./util";

const safeStacks = (repo: string) => {
  try {
    return localStacks(repo);
  } catch {
    return [];
  }
};

const ESC = "\x1b";

/**
 * The top panel: a headline, link buttons, an editor button, app toggles and a
 * message row. It renders from `<meta>/top/<ws>.json` and local app records only,
 * never the network; `refreshTop` is what fills the cache.
 */

/** What the PR rows and their action buttons need. */
export interface PrInfo {
  repo: string;
  number: number;
  title: string;
  draft: boolean;
  /** The repo worktree the `gh` actions run in. */
  dir: string;
  /** Every PR of the stack this PR belongs to, bottom first; empty when unstacked. */
  stack: number[];
  /** Position in the stack, 1-based from the bottom; set only on a stacked PR. */
  layer?: { n: number; of: number };
  /** On a stacked PR: whether this layer is the one the workspace claims (the only one with actions). */
  claimed?: boolean;
  /** Copilot and CodeRabbit, as of the last refresh. */
  reviewers?: ReviewerStatus[];
}

export interface TopLink {
  label: string;
  url: string;
  pr?: PrInfo;
  /** A PR link's state: drives its colour and icon. */
  status?: PrStatus;
}

export const PR_STATUSES = ["merged", "mergeable", "failing", "conflict", "pending", "blocked", "closed", "unknown"] as const;
export type PrStatus = (typeof PR_STATUSES)[number];

/** What `gh pr view --json state,mergeable,mergeStateStatus,statusCheckRollup` returns, as far as we read it. */
export interface PrView extends ReviewerView {
  url?: string;
  title?: string;
  isDraft?: boolean;
  updatedAt?: string;
  state?: string;
  headRefOid?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[];
}

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/** Merged, failing build, conflicts, pending build, then whether it can merge: the first that applies. */
export function classifyPr(pr: PrView): PrStatus {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  const checks = pr.statusCheckRollup ?? [];
  if (checks.some((c) => FAILED.has(c.conclusion ?? "") || FAILED.has(c.state ?? ""))) return "failing";
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "conflict";
  if (checks.some((c) => PENDING.has(c.state ?? "") || (c.status !== undefined && c.status !== "COMPLETED"))) return "pending";
  if (["CLEAN", "UNSTABLE", "HAS_HOOKS"].includes(pr.mergeStateStatus ?? "")) return "mergeable";
  if (["BLOCKED", "BEHIND", "DRAFT"].includes(pr.mergeStateStatus ?? "")) return "blocked";
  return pr.mergeable === "MERGEABLE" ? "mergeable" : "unknown";
}

export const PR_LOOK: Record<PrStatus, { icon: string; color: Color }> = {
  merged: { icon: "🟣", color: "purple" },
  mergeable: { icon: "🟢", color: "green" },
  failing: { icon: "🔴", color: "red" },
  conflict: { icon: "🔴", color: "red" },
  pending: { icon: "🟡", color: "yellow" },
  blocked: { icon: "🔵", color: "blue" },
  closed: { icon: "⚫", color: "grey" },
  unknown: { icon: "⚪", color: "grey" },
};

/** What `refreshTop` stores. `message` is the last problem it hit, shown on the message row. */
export interface TopCache {
  headline?: string;
  /** The item's title alone, without its id. */
  title?: string;
  links: TopLink[];
  /** Every claimed repo's PR is open (and there is at least one claim). Half of what makes a workspace cleanable. */
  prsOpen?: boolean;
  /** Every claimed branch has an open draft PR: the first condition for suggesting `overbridge icebox`. */
  draftOnly?: boolean;
  /** When the claimed PRs last changed (the latest `updatedAt`, ms); part of the idle check. */
  prActiveAt?: number;
  /** Set when every claimed branch's PR has merged: each repo's PR head commit, keyed by repo. */
  merged?: Record<string, string>;
  /** The branch each claimed repo was on when this was built, so `merged` and `prsOpen` are not trusted once a claim moves. */
  branches?: Record<string, string>;
  /** What each configured button's `status` printed, keyed `<repo>/<id>`. A missing entry hides the button. */
  buttons?: Record<string, ButtonState>;
  message?: string;
  at: number;
}

/** A configured button's state from its last `status` run. */
export interface ButtonState {
  text?: string;
  color?: Color;
}

/** A configured button as the panel shows it. */
export interface CustomButton {
  repo: string;
  spec: ButtonSpec;
  dir: string;
  /** Env the button's commands get: the workspace, repo, branch and PR. */
  env: Record<string, string>;
  /** From the cache; undefined until a `status` command has run once. */
  state?: ButtonState;
}

/**
 * Read a `status` command's output: a JSON object `{ "text", "color" }`, or else its first line as the text.
 * An unknown colour is dropped.
 */
export function parseButtonStatus(out: string): ButtonState {
  const trimmed = out.trim();
  if (trimmed.startsWith("{")) {
    try {
      const v = JSON.parse(trimmed) as { text?: unknown; color?: unknown };
      return {
        ...(typeof v.text === "string" && v.text ? { text: v.text } : {}),
        ...(typeof v.color === "string" && v.color in COLORS ? { color: v.color as Color } : {}),
      };
    } catch {
      // not JSON after all: fall through to plain text
    }
  }
  const line = trimmed.split("\n")[0]!.trim();
  return line ? { text: line } : {};
}

/** The env a configured button's commands run with. */
export function buttonEnv(ws: string, repo: string, claim: { branch?: string; pr?: number }): Record<string, string> {
  return { OVERBRIDGE_NAME: ws, OVERBRIDGE_REPO: repo, OVERBRIDGE_BRANCH: claim.branch ?? "", OVERBRIDGE_PR: claim.pr === undefined ? "" : String(claim.pr) };
}

/** Fill `{ws}`, `{repo}`, `{branch}` and `{pr}` in a button's URL, each URL-encoded. */
export function buttonUrl(template: string, env: Record<string, string>): string {
  const vars: Record<string, string> = { ws: env.OVERBRIDGE_NAME ?? "", repo: env.OVERBRIDGE_REPO ?? "", branch: env.OVERBRIDGE_BRANCH ?? "", pr: env.OVERBRIDGE_PR ?? "" };
  return template.replace(/\{(ws|repo|branch|pr)\}/g, (_, k: string) => encodeURIComponent(vars[k]!));
}

export interface TopApp {
  repo: string;
  spec: AppSpec;
  repoDir: string;
  status: AppStatus;
  port?: number;
  /** False when `when:` rules the app out on the current branch. */
  available: boolean;
}

const CONVENTIONAL = /^(?:feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(?:\([^)]*\))?!?:\s*/i;

/** A title without its conventional-commit prefix: `feat(scope): add x` is `add x`. */
export const stripConventional = (title: string): string => title.replace(CONVENTIONAL, "").trim() || title;

/**
 * What the sidebar shows for a workspace: the item's title with no id and no conventional prefix,
 * else the workspace name when no title is cached yet.
 */
export function sidebarLabel(ws: string, cache: Pick<TopCache, "headline" | "title">): string {
  const title = cache.title ?? (cache.headline?.includes(" ") ? cache.headline.replace(/^\S+\s+/, "") : undefined);
  return title ? stripConventional(title) : ws;
}

export interface TopSnapshot {
  ws: string;
  dir: string;
  headline?: string;
  /** The task name: the item's title without id or conventional prefix, else the workspace name. */
  title?: string;
  links: TopLink[];
  ide?: Ide;
  /** `$OVERBRIDGE_IDE`, else `$EDITOR`; used for the editor button when no `ide` is configured. */
  editor?: string;
  apps: TopApp[];
  /** Buttons from the root config. */
  custom?: CustomButton[];
  /** The workspace can be wiped: PRs open, nothing uncommitted, nothing unpushed. */
  cleanup?: boolean;
  message?: string;
}

export const IDE_COMMANDS: Record<Ide, string> = { vscode: "code", zed: "zed", webstorm: "webstorm" };

const cacheFile = (ws: string) => join(metaDir(), "top", `${ws}.json`);

const EMPTY_CACHE: TopCache = { links: [], at: 0 };

/**
 * Why a parsed cache file is not a `TopCache`, or undefined when every field the panes read has the right type:
 * the optional fields when present, and `links` and `at` always (the sweep's age check needs a real `at`).
 */
export function topCacheFault(raw: unknown): string | undefined {
  if (!isRecord(raw)) return `expected a mapping, got ${describeValue(raw)}`;
  const wrong = (field: string, ok: boolean) => (ok ? undefined : `${field} is ${describeValue(raw[field])}`);
  const optional = (field: string, ok: boolean) => (raw[field] === undefined ? undefined : wrong(field, ok));
  return (
    optional("headline", typeof raw.headline === "string") ??
    optional("title", typeof raw.title === "string") ??
    optional("message", typeof raw.message === "string") ??
    optional("prsOpen", typeof raw.prsOpen === "boolean") ??
    optional("draftOnly", typeof raw.draftOnly === "boolean") ??
    optional("prActiveAt", typeof raw.prActiveAt === "number" && Number.isFinite(raw.prActiveAt)) ??
    optional("merged", isRecord(raw.merged)) ??
    optional("branches", isRecord(raw.branches)) ??
    optional("buttons", isRecord(raw.buttons)) ??
    wrong("links", Array.isArray(raw.links)) ??
    wrong("at", typeof raw.at === "number" && Number.isFinite(raw.at))
  );
}

/** The cache file, checked: a missing file is the empty cache; an unreadable or misshapen one is the empty cache plus why, for that workspace's card. */
export function readTopCacheChecked(ws: string): { cache: TopCache; fault?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cacheFile(ws), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { cache: EMPTY_CACHE };
    return { cache: EMPTY_CACHE, fault: `top cache: ${errorMessage(e)}` };
  }
  const fault = topCacheFault(raw);
  return fault ? { cache: EMPTY_CACHE, fault: `top cache: ${fault}` } : { cache: raw as TopCache };
}

/** The cache file as a `TopCache`; the empty cache when it is missing, unreadable or misshapen. */
export const readTopCache = (ws: string): TopCache => readTopCacheChecked(ws).cache;

/**
 * `readTopCache` without what a moved claim invalidates. `merged` and `prsOpen` describe the branches the cache was
 * built for; once a claim moves (a re-bind onto a follow-up item, a layer change) they say nothing about the new
 * branch, so the workspace must not be removed or offered Cleanup on the strength of the old PR. A cache from before
 * `branches` was recorded is trusted until the next refresh.
 */
export function claimedCache(ws: string, cache: TopCache = readTopCache(ws)): TopCache {
  if (!cache.branches || (!cache.merged && !cache.prsOpen)) return cache;
  const moved = Object.entries(getWorkspace(readState(), ws).repos).some(([repo, c]) => c.branch !== undefined && cache.branches?.[repo] !== c.branch);
  if (!moved) return cache;
  const { merged: _m, prsOpen: _p, ...rest } = cache;
  return rest;
}

function writeTopCache(ws: string, cache: TopCache) {
  mkdirSync(join(metaDir(), "top"), { recursive: true });
  const tmp = `${cacheFile(ws)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  renameSync(tmp, cacheFile(ws));
}

const prViewCommand = (n: number) => ["gh", "pr", "view", String(n), "--json", "url,title,isDraft,updatedAt,state,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,reviewRequests,latestReviews,comments"];

function parsePrView(out: string | undefined): PrView | undefined {
  try {
    return out ? (JSON.parse(out) as PrView) : undefined;
  } catch {
    return undefined;
  }
}

/** PR reads the server batched for one workspace, keyed by repo name then PR number: a view, or null for a PR GitHub did not return. */
export type PrefetchedPrs = Record<string, { prs: Record<number, PrView | null> } | { error: string }>;

export interface RefreshDeps {
  /** Read PRs from these instead of running `gh pr view` and the threads query per PR. */
  prefetched?: PrefetchedPrs;
  provider?: (pm: ProjectManagement, dir: string) => Provider;
  /** Run a command in `cwd`; returns trimmed stdout, or undefined on failure. */
  exec?: (cmd: string[], cwd: string) => string | undefined;
}

const defaultExec = (cmd: string[], cwd: string) => {
  const r = run(cmd, { cwd });
  return r.ok && r.stdout ? r.stdout : undefined;
};

/**
 * Rebuild the cache for `ws`: the work item its branches name (headline and link) and a
 * link per claimed PR. Problems land in `message` rather than throwing, so a flaky
 * network leaves the panel up with the old values.
 */
export function refreshTop(ws: string, deps: RefreshDeps = {}): TopCache {
  const provider = deps.provider ?? providerFor;
  const exec = deps.exec ?? defaultExec;
  const old = readTopCache(ws);
  const claims = Object.entries(getWorkspace(readState(), ws).repos);
  const links: TopLink[] = [];
  const problems: string[] = [];
  const claimed = claims.filter(([, c]) => c.branch).length;
  let openPrs = 0;
  let mergedPrs = 0;
  let draftPrs = 0;
  let prActiveAt: number | undefined;
  const mergedHeads: Record<string, string> = {};
  let headline: string | undefined;
  let itemTitle: string | undefined;
  let itemLink: TopLink | undefined;
  const buttonStates: Record<string, ButtonState> = {};

  for (const [repo, claim] of claims) {
    const dir = worktreePath(ws, repo);
    let config;
    try {
      config = loadRepoConfig(dir, repo);
    } catch (e) {
      problems.push(`${repo}: ${(e as Error).message}`);
      continue;
    }
    const pm = config.projectManagement;
    if (pm && claim.branch && !itemLink) {
      try {
        const p = provider(pm, dir);
        const id = p.idFromBranch(claim.branch);
        if (id) {
          const title = refreshTitle(p, pm.project, id);
          headline = title ? `${id} ${title}` : id;
          itemTitle = title || undefined;
          itemLink = { label: id, url: p.link(id) };
        }
      } catch (e) {
        problems.push(`${repo}: ${(e as Error).message}`);
      }
    }
    for (const spec of config.buttons) {
      if (!spec.status) continue;
      const env = Object.entries(buttonEnv(ws, repo, claim)).map(([k, v]) => `${k}=${v}`);
      const out = exec(["env", ...env, "sh", "-c", spec.status], dir);
      if (out !== undefined) buttonStates[`${repo}/${spec.id}`] = parseButtonStatus(out);
    }
    const batched = deps.prefetched?.[repo];
    const viewOf = (n: number): PrView | undefined => {
      if (!batched) return parsePrView(exec(prViewCommand(n), dir));
      return "prs" in batched ? (batched.prs[n] ?? undefined) : undefined;
    };
    if (claim.pr !== undefined) {
      if (batched && "error" in batched) problems.push(`${repo}: ${batched.error}`);
      const view = viewOf(claim.pr);
      if (view?.url) {
        const layers = stackOf(safeStacks(repo), claim.branch)?.layers ?? [];
        const prs = layers.length > 1 ? layers.flatMap((l) => (l.pr === undefined ? [] : [l.pr])) : [];
        const stack = prs.length > 1 && prs.includes(claim.pr as number) ? prs : [];
        const link = (n: number, v: PrView & { url: string }): TopLink => {
          const threads = v.unresolved === undefined ? threadsCommand(v.url) : undefined;
          if (threads) v.unresolved = parseUnresolved(exec(threads, dir));
          const layer = stack.length ? { n: stack.indexOf(n) + 1, of: stack.length } : undefined;
          return {
            label: claims.length > 1 ? `${repo} #${n}` : `PR #${n}`,
            url: v.url,
            status: classifyPr(v),
            pr: { repo, number: n, title: v.title ?? "", draft: v.isDraft === true, dir, stack, ...(layer ? { layer, claimed: n === claim.pr } : {}), reviewers: reviewerStatuses(v, v.url) },
          };
        };
        // a stack lists every layer bottom to top; only the claimed one feeds the open/merged counts below
        for (const n of stack.length ? stack : [claim.pr]) {
          if (n === claim.pr) {
            links.push(link(n, view as PrView & { url: string }));
            continue;
          }
          const other = viewOf(n);
          if (other?.url) links.push(link(n, other as PrView & { url: string }));
          else problems.push(`${repo}: no URL for PR #${n}`);
        }
      }
      else problems.push(`${repo}: no URL for PR #${claim.pr}`);
      if (view?.state === "OPEN") {
        openPrs++;
        if (view.isDraft === true) draftPrs++;
      }
      else if (view?.state === "MERGED") mergedPrs++;
      const updated = Date.parse(view?.updatedAt ?? "");
      if (Number.isFinite(updated)) prActiveAt = Math.max(prActiveAt ?? 0, updated);
      if (claim.branch && view?.state === "MERGED" && view.headRefOid) {
        mergedHeads[repo] = view.headRefOid;
      }
    }
  }

  const cache: TopCache = {
    // keep the previous values when this run found nothing, so the panel never goes blank on an outage
    ...(headline ?? old.headline ? { headline: headline ?? old.headline } : {}),
    ...(itemTitle ?? old.title ? { title: itemTitle ?? old.title } : {}),
    links: itemLink || links.length ? [...(itemLink ? [itemLink] : []), ...links] : old.links,
    // released repos hold no branch, so only claimed branches need an open PR
    // an open PR somewhere, and every other claim already merged: a merged branch is finished, not a reason to keep the workspace
    prsOpen: claimed > 0 && openPrs > 0 && openPrs + mergedPrs === claimed,
    ...(claimed > 0 && openPrs === claimed && draftPrs === claimed ? { draftOnly: true } : {}),
    ...(prActiveAt !== undefined ? { prActiveAt } : {}),
    // a claim with no PR, a closed PR or an unreadable one leaves this unset, so the workspace stays
    ...(claimed > 0 && Object.keys(mergedHeads).length === claimed ? { merged: mergedHeads } : {}),
    branches: Object.fromEntries(claims.flatMap(([repo, c]) => (c.branch ? [[repo, c.branch] as const] : []))),
    ...(Object.keys(buttonStates).length ? { buttons: buttonStates } : {}),
    ...(problems.length ? { message: problems.join("; ") } : {}),
    at: Date.now(),
  };
  writeTopCache(ws, cache);
  return cache;
}

/**
 * Whether `ws` can be wiped: every claimed PR has merged, its agent is empty (just started or cleared), its session was
 * closed on purpose, at least one claimed branch has an open PR and every other one has merged (from the cache), or it
 * is a task workspace that made no commits (`taskWithoutCommits`), and `noUnsavedWork` holds (read from git now, so it
 * is never stale).
 */
export function cleanable(ws: string): boolean {
  if (isOrchestrationTab(ws)) {
    return false;
  }
  const cache = claimedCache(ws);
  const finished = cache.merged !== undefined || cache.prsOpen || readAgentState(ws) === "empty" || sessionEndedForGood(ws) || taskWithoutCommits(ws);
  if (!finished) {
    return false;
  }
  return noUnsavedWork(ws, cache);
}

/**
 * Every claimed branch in `ws` is a `task/` branch with no PR and no commits past its repo's default branch: work that
 * never needed a PR (it filed a ticket, or a spike came to nothing), so no PR will ever mark it finished. A repo whose
 * default branch can't be read keeps the workspace.
 */
export function taskWithoutCommits(ws: string): boolean {
  const claims = Object.entries(getWorkspace(readState(), ws).repos).filter(([, claim]) => claim.branch);
  return (
    claims.length > 0 &&
    claims.every(([repo, claim]) => {
      if (!isTaskClaim(claim)) {
        return false;
      }
      try {
        return git.commitsPast(worktreePath(ws, repo), `origin/${git.defaultBranch(getRepo(repo))}`) === 0;
      } catch {
        return false;
      }
    })
  );
}

/** `mergedClean` once every PR has merged, else `gitClean`. */
export function noUnsavedWork(ws: string, cache: Pick<TopCache, "merged"> = claimedCache(ws)): boolean {
  return cache.merged ? mergedClean(ws, cache.merged) : gitClean(ws);
}

/**
 * No repo in `ws` holds uncommitted changes, and each merged repo's HEAD is its PR's head commit. A squash merge keeps the branch's commits off every remote branch, so
 * comparing with the PR head is what tells pushed-and-merged from local work. A repo with no merged PR (released) falls back to the unpushed check.
 */
export function mergedClean(ws: string, heads: Record<string, string>): boolean {
  return Object.keys(getWorkspace(readState(), ws).repos).every((repo) => {
    const wt = worktreePath(ws, repo);
    if (!existsSync(wt)) {
      return true;
    }
    if (git.isDirty(wt)) {
      return false;
    }
    const head = heads[repo];
    return head === undefined ? !git.hasUnpushed(wt) : git.headSha(wt) === head;
  });
}

/** No repo in `ws` holds uncommitted changes or unpushed commits. Local and fast, so it can run before the tab closes. */
export function gitClean(ws: string): boolean {
  return Object.keys(getWorkspace(readState(), ws).repos).every((repo) => {
    const wt = worktreePath(ws, repo);
    return !git.isDirty(wt) && !git.hasUnpushed(wt);
  });
}

/** Presses of Cleanup within this long of the first one confirm it. */
export const CLEANUP_ARM_MS = 5_000;

/** The first press arms Cleanup; a second within `CLEANUP_ARM_MS` confirms. Pure so the timing is testable. */
export function pressCleanup(armedAt: number | undefined, now: number): { confirmed: boolean; armedAt: number | undefined } {
  if (armedAt !== undefined && now - armedAt <= CLEANUP_ARM_MS) return { confirmed: true, armedAt: undefined };
  return { confirmed: false, armedAt: now };
}

/** Everything the panel draws, from the cache and local app records. */
export async function snapshotTop(ws: string, env: NodeJS.ProcessEnv = process.env): Promise<TopSnapshot> {
  const cache = readTopCache(ws);
  const claimed = getWorkspace(readState(), ws).repos;
  const claims = Object.keys(claimed);
  const apps: TopApp[] = [];
  const custom: CustomButton[] = [];
  let ide: Ide | undefined;
  const problems: string[] = cache.message ? [cache.message] : [];
  for (const repo of claims) {
    const repoDir = worktreePath(ws, repo);
    try {
      const config = loadRepoConfig(repoDir, repo);
      ide ??= config.ide;
      for (const spec of config.buttons) {
        const state = cache.buttons?.[`${repo}/${spec.id}`];
        // a button with a status command waits for it to print something
        if (spec.status && !state) continue;
        custom.push({ repo, spec, dir: repoDir, env: buttonEnv(ws, repo, claimed[repo] ?? {}), ...(state ? { state } : {}) });
      }
      for (const spec of config.apps) {
        const record = readRecord(ws, repo, spec.id);
        apps.push({
          repo,
          spec,
          repoDir,
          status: await appStatus(ws, repo, spec),
          ...(record?.port === undefined ? {} : { port: record.port }),
          available: appAvailable(spec, repo, repoDir),
        });
      }
    } catch (e) {
      problems.push(`${repo}: ${(e as Error).message}`);
    }
  }
  const editor = ide ? undefined : env.OVERBRIDGE_IDE?.trim() || env.EDITOR?.trim() || undefined;
  return {
    ws,
    dir: wsDir(ws),
    ...(cache.headline ? { headline: cache.headline } : {}),
    title: sidebarLabel(ws, cache),
    links: cache.links,
    ...(ide ? { ide } : {}),
    ...(editor ? { editor } : {}),
    apps,
    ...(custom.length ? { custom } : {}),
    ...(cleanable(ws) ? { cleanup: true } : {}),
    ...(problems.length ? { message: problems.join("; ") } : {}),
  };
}

export type PaneKind = "claude" | "terminal" | "diff";

export type Action =
  | { kind: "link"; url: string }
  | { kind: "editor"; cmd: string[]; dir: string }
  | { kind: "app"; app: TopApp }
  | { kind: "pane"; pane: PaneKind }
  | { kind: "ready"; pr: PrInfo }
  | { kind: "merge"; pr: PrInfo }
  | { kind: "cleanup" }
  | { kind: "custom"; button: CustomButton };

export interface Button {
  label: string;
  action: Action;
  /** The key that presses it while the panel is focused; shown in the button. */
  key?: string;
  color?: Color;
  /** Launchers (editor, apps, panes) sit at the right; status buttons (links, Cleanup) at the left. */
  side?: "left" | "right";
  /** Index of the PR this button belongs to: those buttons sit on that PR's own row, the PR first and its actions at the right. */
  prRow?: number;
}

const MARKS: Record<AppStatus, string> = {
  [AppStatus.Stopped]: "⚫",
  [AppStatus.Starting]: "🟡",
  [AppStatus.Running]: "🟢",
  [AppStatus.Exited]: "🔴",
};

const APP_COLORS: Record<AppStatus, Color | undefined> = {
  [AppStatus.Stopped]: undefined,
  [AppStatus.Starting]: "yellow",
  [AppStatus.Running]: "green",
  [AppStatus.Exited]: "red",
};

export const PANE_BUTTONS: { pane: PaneKind; label: string }[] = [
  { pane: "claude", label: "🤖 claude" },
  { pane: "terminal", label: "💻 terminal" },
  { pane: "diff", label: "🔀 diff" },
];

/** Where the editor commands live when the usual name is not on PATH (nixpkgs ships Zed as `zeditor`). */
export const ALT_COMMANDS: Record<string, string> = { zed: "zeditor" };

export const appUrlOf = (app: TopApp): string | undefined => appUrl(app.spec, app.port);

/** Split an editor env value like `code -w` (or an ide name like `zed`) into a command and a label. */
function editorFromEnv(editor: string | undefined): { label: string; cmd: string[] } | undefined {
  const cmd = editor?.split(/\s+/).filter(Boolean);
  if (!cmd?.length) return undefined;
  const name = cmd[0]!;
  if (cmd.length === 1 && name in IDE_COMMANDS) return { label: name, cmd: [IDE_COMMANDS[name as Ide]] };
  return { label: basename(name), cmd };
}

/**
 * Give each button its key: `i` the work item, `p` the PR (then u, y, w, z), `1` to `9` the apps,
 * `e` the editor, `c` `t` `d` the panes, `x` Cleanup, and on the first PR's row `g` ready/draft, `m` merge. Buttons past the available keys get none.
 */
function withKeys(list: Button[]): Button[] {
  let app = 0;
  return list.map((b) => {
    const a = b.action;
    let key: string | undefined;
    if (a.kind === "link" || a.kind === "custom") return b;
    else if (a.kind === "ready") key = b.prRow === 0 ? "g" : undefined;
    else if (a.kind === "merge") key = b.prRow === 0 ? "m" : undefined;
    else if (a.kind === "app") key = app < 9 ? String(++app) : undefined;
    else if (a.kind === "editor") key = "e";
    else if (a.kind === "pane") key = { claude: "c", terminal: "t", diff: "d" }[a.pane];
    else key = "x";
    return key ? { ...b, key } : b;
  });
}

/**
 * Buttons in display order. Left: work item and PR links (coloured by PR status), then Cleanup when the
 * workspace can be wiped. Right: apps, the editor, then the claude / terminal / diff pane toggles.
 * Apps ruled out by `when:` are left out.
 */
/** A Ready/Draft or Merge press the panel shows at once, before the refetch confirms it. */
export type PrChange = { kind: "ready"; pr: PrInfo; ready: boolean } | { kind: "merge"; pr: PrInfo };

/** `snap` as it should look right after `change`: the PR (or every PR of its stack) flipped to draft or ready, or merged. */
export function applyOptimistic(snap: TopSnapshot, change: PrChange): TopSnapshot {
  const numbers = new Set(change.pr.stack.length ? change.pr.stack : [change.pr.number]);
  const links = snap.links.map((l) => {
    if (!l.pr || l.pr.repo !== change.pr.repo || !numbers.has(l.pr.number)) return l;
    return change.kind === "ready" ? { ...l, pr: { ...l.pr, draft: !change.ready } } : { ...l, status: "merged" as const };
  });
  return { ...snap, links };
}

/** Keys for extra PR buttons after `p`; none clash with the panel's own keys. */
const PR_KEYS = ["p", "u", "y", "w", "z"];

export function buttons(snap: TopSnapshot): Button[] {
  const prKeys = [...PR_KEYS];
  const issueKeys = ["i"];
  const out: Button[] = [];
  let prRow = 0;
  for (const l of snap.links) {
    const isPr = l.status !== undefined || l.label.includes("#");
    const key = isPr ? prKeys.shift() : issueKeys.shift();
    const look = l.status ? PR_LOOK[l.status] : undefined;
    const pr = l.pr;
    const name = pr ? `${pr.repo} #${pr.number}${pr.layer ? ` ${pr.layer.n}/${pr.layer.of}` : ""}${pr.title ? ` ${pr.title}` : ""}` : l.label;
    out.push({
      label: look ? `${look.icon} ${name}` : `📋 ${name}`,
      action: { kind: "link", url: l.url },
      side: "left",
      ...(pr ? { prRow } : {}),
      ...(key ? { key } : {}),
      ...(look ? { color: look.color } : {}),
    });
    if (pr) {
      const row = prRow++;
      for (const r of pr.reviewers ?? []) out.push({ label: reviewerLabel(r), action: { kind: "link", url: r.url ?? l.url }, side: "right", color: REVIEWER_LOOK[r.state].color, prRow: row });
      if (l.status !== "merged" && l.status !== "closed" && pr.claimed !== false) {
        out.push({ label: pr.draft ? "✅ Ready" : "📝 Draft", action: { kind: "ready", pr }, side: "right", prRow: row });
        if (l.status === "mergeable" && !pr.draft) out.push({ label: pr.stack.length > 1 ? "🟣 Merge stack" : "🟣 Merge", action: { kind: "merge", pr }, side: "right", color: "purple", prRow: row });
      }
    }
  }
  if (snap.cleanup) out.push({ label: "🧹 Cleanup", action: { kind: "cleanup" }, side: "left" });
  const repos = new Set((snap.custom ?? []).map((c) => c.repo));
  for (const c of snap.custom ?? []) {
    const name = repos.size > 1 ? `${c.repo} ${c.spec.label}` : c.spec.label;
    const text = c.state?.text ? `${name}: ${c.state.text}` : name;
    out.push({ label: text, action: { kind: "custom", button: c }, side: c.spec.side, ...(c.state?.color ? { color: c.state.color } : {}) });
  }
  for (const app of snap.apps) {
    if (!app.available) continue;
    const port = app.status === AppStatus.Stopped || app.port === undefined ? "" : ` :${app.port}`;
    const color = APP_COLORS[app.status];
    out.push({ label: `${MARKS[app.status]} ${app.spec.label}${port}`, action: { kind: "app", app }, side: "right", ...(color ? { color } : {}) });
  }
  const editor = snap.ide ? { label: snap.ide, cmd: [IDE_COMMANDS[snap.ide]] } : editorFromEnv(snap.editor);
  if (editor) out.push({ label: `📝 ${editor.label}`, action: { kind: "editor", cmd: editor.cmd, dir: snap.dir }, side: "right" });
  for (const p of PANE_BUTTONS) out.push({ label: p.label, action: { kind: "pane", pane: p.pane }, side: "right" });
  return withKeys(out);
}

export interface Placed {
  button: Button;
  /** 0-based row within the panel and 0-based start column. */
  row: number;
  col: number;
  width: number;
}

/** A section divider: plain text on one row, no button. */
export interface Rule {
  row: number;
  text: string;
}

/** Heads the launcher section (apps, editor, pane toggles) when PR rows sit above it. */
const actionsRule = (width: number): string => "── actions ".padEnd(width, "─");

export interface Frame {
  /** Plain text rows, border included (buttons too, for reading); the cursor and colours are drawn from `placed`. */
  rows: string[];
  placed: Placed[];
  /** Divider rows between sections: 0-based row within the panel and the text drawn across it. */
  rules: Rule[];
  /** The task name set into the top border. */
  title: string;
  /** The note set into the bottom border. */
  message: string;
  width: number;
}

/** The text of a button: its label, then its key hint (when it has one). */
export const cell = (b: Button) => `[ ${b.label}${b.key ? ` · ${b.key}` : ""} ]`;
const clip = (s: string, width: number) => fit(s, width).trimEnd();

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Lay the panel out for `width` columns inside a rounded frame titled with the task name: one row of
 * buttons with the left group at the left edge and the right group against the right edge (the right
 * group drops to its own row when both do not fit; either group wraps when it is too wide alone),
 * padded to `height` rows, with the message set into the bottom border.
 * Pure, so resizing is just calling it again.
 */
export function layoutTop(snap: TopSnapshot, width: number, height = 0): Frame {
  const inner = Math.max(1, width - 4);
  const content: string[] = [];
  const placed: Placed[] = [];
  const all = buttons(snap);
  const cells = (side: "left" | "right") => all.filter((b) => b.prRow === undefined && (b.side ?? "left") === side).map((button) => ({ button, text: clip(cell(button), inner) }));
  const widthOf = (items: { text: string }[]) => items.reduce((n, i) => n + textWidth(i.text) + 1, 0) - (items.length ? 1 : 0);

  // wrap `items` into rows of at most `inner`, each row starting at `start(rowWidth)`
  const flow = (items: { button: Button; text: string }[], align: "left" | "right", firstRow?: { row: number; used: number }) => {
    let row = firstRow?.row ?? base;
    let line: typeof items = [];
    const flush = () => {
      if (!line.length) return;
      let col = align === "left" ? (row === firstRow?.row ? firstRow.used : 0) : Math.max(0, inner - widthOf(line));
      for (const item of line) {
        placed.push({ button: item.button, row, col, width: textWidth(item.text) });
        col += textWidth(item.text) + 1;
      }
      row++;
      line = [];
    };
    for (const item of items) {
      const base = align === "left" && row === firstRow?.row ? firstRow.used : 0;
      if (line.length && base + widthOf([...line, item]) > inner) flush();
      line.push(item);
    }
    flush();
    return row;
  };

  // one row per PR: the PR first, its actions against the right edge
  let base = 0;
  for (const row of new Set(all.flatMap((b) => (b.prRow === undefined ? [] : [b.prRow])))) {
    const group = all.filter((b) => b.prRow === row);
    const main = group.find((b) => b.side !== "right")!;
    const actions = group.filter((b) => b !== main).map((button) => ({ button, text: clip(cell(button), inner) }));
    const taken = widthOf(actions) + (actions.length ? 2 : 0);
    const text = clip(cell(main), Math.max(1, inner - taken));
    placed.push({ button: main, row: base, col: 0, width: textWidth(text) });
    let col = inner - widthOf(actions);
    for (const a of actions) {
      placed.push({ button: a.button, row: base, col, width: textWidth(a.text) });
      col += textWidth(a.text) + 1;
    }
    base++;
  }

  const left = cells("left");
  const right = cells("right");
  const rules: Rule[] = [];
  if (base > 0 && right.length) {
    // PR rows above: the launchers get their own section under a divider, so they never read as PR actions
    const next = flow(left, "left");
    rules.push({ row: next, text: actionsRule(inner) });
    flow(right, "left", { row: next + 1, used: 0 });
  } else if (left.length && right.length && widthOf(left) + 2 + widthOf(right) <= inner) {
    flow(left, "left");
    flow(right, "right", { row: base, used: 0 });
  } else {
    flow(right, "right", { row: flow(left, "left"), used: 0 });
  }
  const used = Math.max(0, ...placed.map((p) => p.row + 1));
  for (let y = 0; y < Math.max(used, height - 2, 1); y++) {
    let text = "";
    const rule = rules.find((r) => r.row === y);
    if (rule) text = fit(rule.text, inner).trimEnd();
    for (const p of placed.filter((q) => q.row === y).sort((a, b) => a.col - b.col)) {
      text += " ".repeat(Math.max(0, p.col - textWidth(text))) + clip(cell(p.button), p.width);
    }
    content.push(text);
  }
  // inside the frame: one row down for the top border, two columns across for the border and padding
  const shifted = placed.map((p) => ({ ...p, row: p.row + 1, col: p.col + 2 }));
  const title = snap.title ?? snap.headline ?? snap.ws;
  const message = snap.message ?? "";
  const rows = [plain(boxTop(title, width)), ...content.map((r) => plain(boxRow(fit(r, inner)))), plain(boxBottom(width, message))];
  return { rows, placed: shifted, rules: rules.map((r) => ({ ...r, row: r.row + 1 })), title, message, width };
}

/** The button under a 0-based (col,row) cell, if any. */
export function hit(frame: Frame, col: number, row: number): number | undefined {
  const i = frame.placed.findIndex((p) => p.row === row && col >= p.col && col < p.col + p.width);
  return i < 0 ? undefined : i;
}

/**
 * The terminal output that draws `f`: clear, the frame (title bold in the top border, the message in
 * yellow in the bottom one), then each button at its cell, in its colour, inverse under `cursor`.
 */
export function paintTop(f: Frame, cursor: number): string {
  let out = `${ESC}[H${ESC}[2J`;
  const last = f.rows.length - 1;
  const blank = boxRow(" ".repeat(Math.max(1, f.width - 4)));
  f.rows.forEach((_, y) => {
    out += `${ESC}[${y + 1};1H${y === 0 ? boxTop(f.title, f.width) : y === last ? boxBottom(f.width, f.message) : blank}`;
  });
  for (const r of f.rules) out += `${ESC}[${r.row + 1};3H${ESC}[2m${fit(r.text, Math.max(1, f.width - 4))}${ESC}[0m`;
  f.placed.forEach((p, i) => {
    const text = clip(cell(p.button), p.width);
    const shown = i === cursor ? inverse(text) : p.button.color ? colorize(text, p.button.color) : text;
    out += `${ESC}[${p.row + 1};${p.col + 1}H${shown}`;
  });
  return out;
}

export interface ActDeps {
  open: (url: string) => void;
  /** Launch `cmd` detached. */
  spawn: (cmd: string[]) => void;
  start: (app: TopApp) => void;
  stop: (app: TopApp) => void;
  /** Toggle a pane; returns a message for the message row. */
  pane: (pane: PaneKind) => string | undefined;
  /** Wipe the workspace; returns a message for the message row. */
  cleanup: () => string | undefined;
  /** Turn the PR (or its stack) ready for review, or back to draft. */
  ready: (pr: PrInfo, ready: boolean) => string | undefined;
  /** Merge the PR (or its stack); asks for a second press first. */
  merge: (pr: PrInfo) => string | undefined;
  /** Run a configured button's shell command, detached, in `dir` with `env` added. */
  run: (command: string, dir: string, env: Record<string, string>) => void;
}

/** Do what a button says; returns a message for the message row, or undefined. */
export function activate(button: Button, deps: ActDeps): string | undefined {
  const a = button.action;
  switch (a.kind) {
    case "link":
      deps.open(a.url);
      return undefined;
    case "editor":
      deps.spawn([...a.cmd, a.dir]);
      return undefined;
    case "pane":
      return deps.pane(a.pane);
    case "cleanup":
      return deps.cleanup();
    case "ready":
      return deps.ready(a.pr, a.pr.draft);
    case "merge":
      return deps.merge(a.pr);
    case "custom": {
      const { spec, dir, env } = a.button;
      if (spec.url) deps.open(buttonUrl(spec.url, env));
      else if (spec.run) deps.run(spec.run, dir, env);
      return undefined;
    }
    case "app": {
      const live = a.app.status === AppStatus.Running || a.app.status === AppStatus.Starting;
      try {
        if (live) deps.stop(a.app);
        else deps.start(a.app);
      } catch (e) {
        return (e as Error).message;
      }
      return undefined;
    }
  }
}

/** `o` on an app button: its URL when it is running. */
export function openTarget(button: Button): string | undefined {
  const a = button.action;
  return a.kind === "app" && a.app.status === AppStatus.Running ? appUrlOf(a.app) : undefined;
}
