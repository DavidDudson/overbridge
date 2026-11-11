import { readAgentAt } from "./agent-state";
import * as git from "./git";
import { worktreePath } from "./paths";
import { loadRepoConfig } from "./project-config";
import { getWorkspace, readState } from "./state";
import type { TopCache } from "./top";

const DAY_MS = 86_400_000;

export interface IdleFacts {
  /** The configured threshold in days; undefined turns the suggestion off. */
  idleDays: number | undefined;
  /** Every claimed branch has an open draft PR. */
  draftOnly: boolean | undefined;
  /** Last commit, last PR update and last agent record (ms); the latest known one is the last activity. */
  activityMs: (number | undefined)[];
  now: number;
}

/** Whole days since the last known activity when `facts` call for a suggestion; undefined otherwise, including when no activity is known. */
export function idleDaysFor(facts: IdleFacts): number | undefined {
  const known = facts.activityMs.filter((t): t is number => t !== undefined);
  if (facts.idleDays === undefined || !facts.draftOnly || known.length === 0) {
    return undefined;
  }
  const days = Math.floor((facts.now - Math.max(...known)) / DAY_MS);
  return days >= facts.idleDays ? days : undefined;
}

/** The smallest `icebox.idle-days` among the repos of `ws`; a repo whose config cannot be read adds nothing. */
export function idleThreshold(ws: string): number | undefined {
  const days = Object.keys(getWorkspace(readState(), ws).repos).flatMap((repo) => {
    try {
      const value = loadRepoConfig(worktreePath(ws, repo), repo).icebox.idleDays;
      return value === undefined ? [] : [value];
    } catch {
      return [];
    }
  });
  return days.length ? Math.min(...days) : undefined;
}

/**
 * The sidebar hint for `ws`: `draft PRs idle <n>d`, or undefined. Reads local files only (git, the agent record) plus
 * the cached PR facts, and does nothing until the cache says every PR is a draft.
 */
export function iceboxHint(ws: string, cache: Pick<TopCache, "draftOnly" | "prActiveAt">, now = Date.now()): string | undefined {
  if (!cache.draftOnly) {
    return undefined;
  }
  const commits = Object.keys(getWorkspace(readState(), ws).repos).map((repo) => git.headTimeMs(worktreePath(ws, repo)));
  const days = idleDaysFor({ idleDays: idleThreshold(ws), draftOnly: cache.draftOnly, activityMs: [...commits, cache.prActiveAt, readAgentAt(ws)], now });
  return days === undefined ? undefined : `draft PRs idle ${days}d · icebox?`;
}
