import { existsSync } from "node:fs";
import { getRepo } from "./config";
import * as git from "./git";
import { worktreePath } from "./paths";
import { getWorkspace, isIceboxed, readState, type State } from "./state";
import { errorMessage, naturalSort, run } from "./util";

/** A worktree whose branch holds commits the default branch lacks. */
export interface AheadRow {
  ws: string;
  repo: string;
  branch: string;
  /** Equal to `ws`: the name the workspace's Claude session runs under. */
  session: string;
  /** The ref compared against, e.g. `origin/main`. */
  base: string;
  /** Commits on HEAD that `base` lacks. */
  ahead: number;
  /** Commits on `base` that HEAD lacks: how far main has moved on. */
  behind: number;
  /** Newest first, at most `MAX_SUBJECTS`. */
  subjects: string[];
  /** Author date of the newest commit (ISO 8601). */
  lastCommit: string;
  pr?: number;
  dirty: boolean;
}

export const MAX_SUBJECTS = 10;

/** What reading a worktree needs; injectable so tests need no git. */
export interface AheadDeps {
  state: () => State;
  base: (repo: string) => string;
  exists: (path: string) => boolean;
  head: (wt: string) => string;
  dirty: (wt: string) => boolean;
  /** `git` output for `args` in `wt`, trimmed; undefined on failure. */
  git: (wt: string, args: string[]) => string | undefined;
}

export const realDeps: AheadDeps = {
  state: readState,
  base: (repo) => `origin/${git.defaultBranch(getRepo(repo))}`,
  exists: existsSync,
  head: git.head,
  dirty: git.isDirty,
  git: (wt, args) => {
    const r = run(["git", "-C", wt, ...args]);

    return r.ok ? r.stdout : undefined;
  },
};

const count = (deps: AheadDeps, wt: string, range: string): number | undefined => {
  const n = deps.git(wt, ["rev-list", "--count", range]);

  return n !== undefined && /^\d+$/.test(n) ? Number(n) : undefined;
};

/** The row for one worktree, or undefined when it is not ahead or cannot be read. */
function aheadRow(deps: AheadDeps, ws: string, repo: string, pr: number | undefined): AheadRow | undefined {
  const wt = worktreePath(ws, repo);

  if (!deps.exists(wt)) return undefined;
  const branch = deps.head(wt);
  const base = deps.base(repo);

  if (branch === "HEAD" || `origin/${branch}` === base) return undefined;
  const ahead = count(deps, wt, `${base}..HEAD`);
  const behind = count(deps, wt, `HEAD..${base}`);

  if (!ahead || behind === undefined) return undefined;
  const subjects = (deps.git(wt, ["log", `-${MAX_SUBJECTS}`, "--format=%s", `${base}..HEAD`]) ?? "").split("\n").filter(Boolean);
  const lastCommit = deps.git(wt, ["log", "-1", "--format=%aI"]) ?? "";

  const row: AheadRow = { ws, repo, branch, session: ws, base, ahead, behind, subjects, lastCommit, dirty: deps.dirty(wt) };

  if (pr !== undefined) row.pr = pr;

  return row;
}

/**
 * Worktrees of live workspaces ahead of their default branch. A detached HEAD, missing worktree or failed git read is
 * skipped, never guessed. A worktree whose read throws (an unregistered repo, a broken clone) is reported through
 * `warn` and skipped, so one bad workspace never hides the rest.
 */
export function aheadRows(deps: AheadDeps = realDeps, warn: (message: string) => void = console.error): AheadRow[] {
  const state = deps.state();

  return Object.keys(state.workspaces)
    .sort(naturalSort)
    .flatMap((ws) => {
      const w = getWorkspace(state, ws);

      if (isIceboxed(w)) return [];

      return Object.entries(w.repos).flatMap(([repo, claim]) => {
        try {
          return aheadRow(deps, ws, repo, claim.pr) ?? [];
        } catch (e) {
          warn(`ahead: skipped ${ws}/${repo}: ${errorMessage(e)}`);

          return [];
        }
      });
    });
}
