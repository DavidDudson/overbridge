import { run, type RunResult } from "./util";

type Exec = (cmd: string[], cwd: string) => RunResult;
const defaultExec: Exec = (cmd, cwd) => run(cmd, { cwd });

/** What a PR button acts on: the repo worktree and its PR, plus every PR of its stack (just itself when unstacked). */
export interface PrTarget {
  dir: string;
  number: number;
  /** Every PR of the stack the PR belongs to, bottom first; empty when it is not stacked. */
  stack: number[];
}

const failure = (r: RunResult) => r.stderr.split("\n")[0] || r.stdout.split("\n")[0] || `exit ${r.code}`;

/**
 * Turn a PR, or every PR of its stack, to ready for review (`ready`) or back to draft.
 * Returns the message to show: what happened or the first error line.
 */
export function setReady(target: PrTarget, ready: boolean, exec: Exec = defaultExec): string {
  const prs = target.stack.length ? target.stack : [target.number];
  for (const n of prs) {
    const r = exec(["gh", "pr", "ready", ...(ready ? [] : ["--undo"]), String(n)], target.dir);
    if (!r.ok) return `PR #${n}: ${failure(r)}`;
  }
  const what = prs.length > 1 ? `${prs.length} PRs` : `PR #${prs[0]}`;
  return `${what} ${ready ? "ready for review" : "back to draft"}`;
}

/** The merge flag for the first method the repo allows: squash, then merge commit, then rebase. */
export function mergeFlag(allowed: { squashMergeAllowed?: boolean; mergeCommitAllowed?: boolean; rebaseMergeAllowed?: boolean }): string | undefined {
  if (allowed.squashMergeAllowed) return "--squash";
  if (allowed.mergeCommitAllowed) return "--merge";
  if (allowed.rebaseMergeAllowed) return "--rebase";
  return undefined;
}

/**
 * Merge the PR, or the whole stack when it has one (GitHub's atomic stack merge; it refuses unless every layer can merge).
 * The branch is left alone: workspaces hold claims on it.
 */
export function mergePr(target: PrTarget, exec: Exec = defaultExec): string {
  if (target.stack.length > 1) {
    const r = exec(["gh", "stack", "merge", "--yes"], target.dir);
    return r.ok ? `merged a stack of ${target.stack.length} PRs` : `stack merge failed: ${failure(r)}`;
  }
  const info = exec(["gh", "repo", "view", "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"], target.dir);
  let flag: string | undefined;
  try {
    flag = mergeFlag(JSON.parse(info.stdout));
  } catch {
    flag = undefined;
  }
  if (!flag) return `PR #${target.number}: could not tell which merge method the repo allows`;
  const r = exec(["gh", "pr", "merge", String(target.number), flag], target.dir);
  return r.ok ? `merged PR #${target.number}` : `PR #${target.number}: ${failure(r)}`;
}
