/**
 * gh-stack (`gh stack`) integration. A stack is claimed as a unit: a workspace
 * holding any layer owns every layer, so `gh stack up/down/add/rebase` never
 * reach into another workspace's worktree.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { barePath } from "./paths";
import { run } from "./util";

export type StackLayer = { branch: string; pr?: number };

export type Stack = { number?: number; trunk: string; layers: StackLayer[] };

export type Cover = { branches: Set<string>; prs: Set<number>; issues: Set<number> };

/** The issue a `<type>/<n>-<slug>` branch works on (`feat/383-iwr` → 383), so two branch names for one issue clash. */
export function issueOf(branch: string): number | undefined {
  const m = /^[a-z]+\/(\d+)-[a-z]/.exec(branch);

  return m ? Number(m[1]) : undefined;
}

/**
 * Where gh-stack keeps its catalogs: each worktree's own git dir (`worktrees/<name>/gh-stack`, gh-stack 0.0.8 and
 * later), then the shared bare repo (older gh-stack). Every one is read, so every workspace sees every stack.
 */
export function catalogPaths(bare: string): string[] {
  let worktrees: string[];

  try {
    worktrees = readdirSync(join(bare, "worktrees")).toSorted();
  } catch {
    worktrees = [];
  }

  return [...worktrees.map((w) => join(bare, "worktrees", w, "gh-stack")), join(bare, "gh-stack")];
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

/** Stacks tracked locally by gh-stack across every catalog of `repo`; a stack listed in two catalogs appears once, from the first in `catalogPaths` order. */
export function localStacks(repo: string): Stack[] {
  const all = catalogPaths(barePath(repo)).flatMap(readCatalog);
  const key = (s: Stack) => s.layers.map((l) => l.branch).join("\0");

  return all.filter((s, i) => all.findIndex((t) => key(t) === key(s)) === i);
}

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

    for (const l of stackOf(stacks, b)?.layers ?? []) add(l.branch, l.pr);
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
