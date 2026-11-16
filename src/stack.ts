/**
 * gh-stack (`gh stack`) integration. A stack is claimed as a unit: a workspace
 * holding any layer owns every layer, so `gh stack up/down/add/rebase` never
 * reach into another workspace's worktree.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { barePath } from "./paths";
import { errorMessage, log, run } from "./util";

export type StackLayer = { branch: string; pr?: number };

export type Stack = { number?: number; trunk: string; layers: StackLayer[] };

export type Cover = { branches: Set<string>; prs: Set<number>; issues: Set<number> };

/** The issue a `<type>/<n>-<slug>` branch works on (`feat/383-iwr` → 383), so two branch names for one issue clash. */
export function issueOf(branch: string): number | undefined {
  const m = /^[a-z]+\/(\d+)-[a-z]/.exec(branch);

  return m ? Number(m[1]) : undefined;
}

/**
 * gh-stack's catalogs: each live worktree's own git dir (`worktrees/<name>/gh-stack`), then the shared bare repo older
 * gh-stack used. A worktree whose folder is gone (not yet pruned) is left out, so its stack claims nothing.
 */
export function catalogPaths(bare: string): string[] {
  let worktrees: string[];

  try {
    worktrees = readdirSync(join(bare, "worktrees")).toSorted();
  } catch (e) {
    // only a missing folder means no worktrees; any other failure throws, so a claim never fails open
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) {
      throw e;
    }

    worktrees = [];
  }

  // only a folder known to be gone drops a worktree; an unreadable `gitdir` keeps it, so a claim never fails open
  const live = worktrees.filter((w) => {
    const admin = join(bare, "worktrees", w);

    try {
      // git's worktree.useRelativePaths writes `gitdir` relative to the admin dir
      return existsSync(resolve(admin, readFileSync(join(admin, "gitdir"), "utf8").trim()));
    } catch {
      return true;
    }
  });

  return [...live.map((w) => join(bare, "worktrees", w, "gh-stack")), join(bare, "gh-stack")];
}

function readCatalog(path: string): Stack[] {
  let file: any;

  try {
    file = JSON.parse(readFileSync(path, "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return [];
    throw e;
  }

  return (file.stacks ?? []).map((s: any) => ({
    number: s.number || undefined,
    trunk: s.trunk?.branch ?? "",
    layers: (s.branches ?? []).map((b: any) => ({ branch: b.branch, pr: b.pullRequest?.number })),
  }));
}

/** How a worktree's catalog is read: `readCatalog` throws on a bad file, `readWorktreeCatalog` skips it. */
type CatalogReader = (path: string) => Stack[];

/** Bad catalogs already logged, so a poll does not repeat the line. */
const loggedBad = new Set<string>();

/** A worktree's catalog that cannot be read is skipped and logged once, so one workspace's bad file never blanks another's panes. */
export function readWorktreeCatalog(path: string): Stack[] {
  try {
    return readCatalog(path);
  } catch (e) {
    const line = `skipped gh-stack catalog ${path}: ${errorMessage(e)}`;

    if (!loggedBad.has(line)) {
      loggedBad.add(line);
      log(line);
    }

    return [];
  }
}

/**
 * Stacks in every gh-stack catalog of bare repo `bare`, each worktree catalog read with `readWorktree`; a stack listed in
 * two catalogs appears once, from the first in `catalogPaths` order. The shared catalog always throws when it is bad.
 */
export function stacksIn(bare: string, readWorktree: CatalogReader = readCatalog): Stack[] {
  const shared = join(bare, "gh-stack");
  const all = catalogPaths(bare).flatMap((p) => (p === shared ? readCatalog(p) : readWorktree(p)));
  const key = (s: Stack) => s.layers.map((l) => l.branch).join("\0");
  // reversed, so the first index of each key is the one the Map keeps
  const firstAt = new Map(all.map((s, i) => [key(s), i] as const).toReversed());

  return all.filter((s, i) => firstAt.get(key(s)) === i);
}

/** Stacks tracked locally by gh-stack for `repo`, for claim checks: any catalog that cannot be read throws, so a claim never fails open. */
export const localStacks = (repo: string): Stack[] => stacksIn(barePath(repo));

/** Stacks for `repo` to show: a worktree catalog that cannot be read is skipped and logged. */
export const displayStacks = (repo: string): Stack[] => stacksIn(barePath(repo), readWorktreeCatalog);

/** Stack with `branch` as one of its layers (the trunk is not a layer). */
export const stackOf = (stacks: Stack[], branch?: string) =>
  branch ? stacks.find((s) => s.layers.some((l) => l.branch === branch)) : undefined;

/** Branches, PRs and issues covered by `branches`/`prs`, widened to every layer of any stack they touch. */
export function cover(stacks: Stack[], branches: (string | undefined)[], prs: (number | undefined)[] = []): Cover {
  const c: Cover = { branches: new Set(), prs: new Set(), issues: new Set() };

  const add = (b?: string, pr?: number) => {
    if (b) c.branches.add(b);
    const issue = b && issueOf(b);

    if (issue) c.issues.add(issue);

    if (pr) c.prs.add(pr);
  };

  for (const pr of prs) add(undefined, pr);

  for (const b of branches) {
    add(b);

    // every stack holding `b`, not only the first: two catalogs can list one branch in different stacks
    for (const s of stacks.filter((s) => s.layers.some((l) => l.branch === b))) {
      s.layers.forEach((l) => add(l.branch, l.pr));
    }
  }

  for (const s of stacks) if (s.layers.some((l) => l.pr && c.prs.has(l.pr))) s.layers.forEach((l) => add(l.branch, l.pr));

  return c;
}

export const overlaps = (a: Cover, b: Cover) =>
  [...a.branches].some((x) => b.branches.has(x)) ||
  [...a.prs].some((x) => b.prs.has(x)) ||
  [...a.issues].some((x) => b.issues.has(x));

/** One-line chain, gh-stack style: `(main) <- a <- b`. */
export const chain = (s: Stack) => [`(${s.trunk})`, ...s.layers.map((l) => l.branch)].join(" <- ");

const STACK_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      stack { number baseRefName entries(first: 100) { nodes { position pullRequest { number headRefName } } } }
    }
  }
}`;

/** The GitHub stack PR `pr` belongs to, if any. Errors (no access, no stack API) read as "not stacked". */
export function remoteStack(wt: string, pr: number): Stack | undefined {
  const r = run(
    ["gh", "api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-F", `number=${pr}`, "-f", `query=${STACK_QUERY}`],
    { cwd: wt },
  );

  if (!r.ok) return;
  const s = JSON.parse(r.stdout)?.data?.repository?.pullRequest?.stack;

  if (!s) return;
  const nodes = [...s.entries.nodes].sort((a: any, b: any) => a.position - b.position);

  return {
    number: s.number,
    trunk: s.baseRefName,
    layers: nodes.map((n: any) => ({ branch: n.pullRequest.headRefName, pr: n.pullRequest.number })),
  };
}

export const hasGhStack = () => run(["gh", "stack", "--version"]).ok;
