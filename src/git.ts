import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RepoSpec } from "./config";
import { barePath } from "./paths";
import { fail, log, must, run } from "./util";

/** Clone `spec` as a bare repo with a normal remote-tracking refspec. No-op if present. */
export function ensureBare(spec: RepoSpec): string {
  const bare = barePath(spec.name);
  if (existsSync(bare)) return bare;
  mkdirSync(dirname(bare), { recursive: true });
  log(`cloning ${spec.url} → ${bare}`);
  must(["git", "clone", "--bare", spec.url, bare]);
  // Bare clones map remote heads straight onto local heads; switch to
  // refs/remotes/origin/* so worktrees can track remote branches normally.
  must(["git", "-C", bare, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"]);
  must(["git", "-C", bare, "fetch", "origin", "--prune", "--quiet"]);
  const def = defaultBranch(spec);
  const heads = must(["git", "-C", bare, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  for (const b of heads.split("\n").filter(Boolean)) {
    if (b !== def) must(["git", "-C", bare, "branch", "-D", b]);
  }
  return bare;
}

export function defaultBranch(spec: RepoSpec): string {
  if (spec.defaultBranch) return spec.defaultBranch;
  return must(["git", "-C", barePath(spec.name), "symbolic-ref", "--short", "HEAD"]);
}

export function fetch(spec: RepoSpec) {
  must(["git", "-C", ensureBare(spec), "fetch", "origin", "--prune", "--quiet"]);
}

export function addWorktree(spec: RepoSpec, path: string) {
  const bare = ensureBare(spec);
  fetch(spec);
  must(["git", "-C", bare, "worktree", "add", "--quiet", "--detach", path, `origin/${defaultBranch(spec)}`]);
}

export function removeWorktree(spec: RepoSpec, path: string, force: boolean) {
  const bare = barePath(spec.name);
  if (!existsSync(bare)) return;
  if (existsSync(path)) must(["git", "-C", bare, "worktree", "remove", ...(force ? ["--force"] : []), path]);
  must(["git", "-C", bare, "worktree", "prune"]);
}

const hasRef = (wt: string, ref: string) => run(["git", "-C", wt, "show-ref", "--verify", "--quiet", ref]).ok;

export function validateBranch(name: string) {
  if (!run(["git", "check-ref-format", "--branch", name]).ok) fail(`invalid branch name '${name}'`);
}

/** Switch worktree to `branch`: local if it exists, else track origin, else create from `base`. */
export function switchTo(wt: string, branch: string, base: string) {
  if (hasRef(wt, `refs/heads/${branch}`)) must(["git", "-C", wt, "switch", branch]);
  else if (hasRef(wt, `refs/remotes/origin/${branch}`))
    must(["git", "-C", wt, "switch", "-c", branch, "--track", `origin/${branch}`]);
  else must(["git", "-C", wt, "switch", "--no-track", "-c", branch, base]);
}

export function head(wt: string): string {
  if (!existsSync(wt)) return "(missing)";
  const b = run(["git", "-C", wt, "branch", "--show-current"]).stdout;
  return b || `detached@${run(["git", "-C", wt, "rev-parse", "--short", "HEAD"]).stdout}`;
}

export function isDirty(wt: string): boolean {
  return existsSync(wt) && run(["git", "-C", wt, "status", "--porcelain"]).stdout !== "";
}

export type PrInfo = { number: number; headRefName: string; isCrossRepository: boolean };

/** Accepts `#123`, `pr:123`, or a PR URL. Returns the gh selector, or undefined if `ref` is a branch. */
export function parsePrRef(ref: string): string | undefined {
  const m = /^(?:#|pr:)(\d+)$/i.exec(ref);
  if (m) return m[1];
  if (/^https?:\/\/.+\/pull\/\d+/.test(ref)) return ref;
}

export function prInfo(wt: string, selector: string): PrInfo {
  return JSON.parse(must(["gh", "pr", "view", selector, "--json", "number,headRefName,isCrossRepository"], { cwd: wt }));
}

/** PR number for a branch, if one is open. */
export function prForBranch(wt: string, branch: string): number | undefined {
  const r = run(["gh", "pr", "view", branch, "--json", "number"], { cwd: wt });
  return r.ok ? JSON.parse(r.stdout).number : undefined;
}
