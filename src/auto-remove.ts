import { sessionEndedForGood } from "./agent-state";
import { isOrchestrationTab } from "./orchestration";
import { CleanupCause } from "./cleanup-log";
import { beginRemoval, Landing } from "./remove";
import { gitClean } from "./top";
import { errorMessage } from "./util";

/** How long one sidebar trusts a git check of an ended workspace before running it again. */
export const GIT_RECHECK_MS = 10_000;

export interface ReapDeps {
  endedForGood: (ws: string) => boolean;
  gitClean: (ws: string) => boolean;
  /** Start removing `ws`; returns why it refused, or undefined once under way. */
  remove: (ws: string) => string | undefined;
  now: () => number;
}

/** A sidebar entry the reaper looks at. */
export interface ReapCandidate {
  tab: string;
  /** A failed earlier removal; the workspace waits for the user instead of failing again every poll. */
  error?: string;
  /** The entry could not be read (bad cache or state record); the reaper leaves it alone. */
  fault?: string;
}

/** What one reap found: the ended workspaces kept for unsaved work, and those a check or removal threw on. */
export interface ReapResult {
  unsaved: ReadonlySet<string>;
  /** Workspace to the message of what threw; retried after `GIT_RECHECK_MS`. */
  faults: ReadonlyMap<string, string>;
}

const defaultDeps = (): ReapDeps => ({
  endedForGood: (ws) => sessionEndedForGood(ws),
  gitClean,
  remove: (ws) => beginRemoval(ws, { landing: Landing.IfFocused, cause: CleanupCause.SessionEnded }),
  now: Date.now,
});

/**
 * Removes every workspace whose session the user closed on purpose and whose git work is all pushed, one workspace at a
 * time: a throw (gone from state since the list was built, a locked state file) is reported for that workspace alone.
 */
export function createReaper(deps: ReapDeps = defaultDeps()): (candidates: readonly ReapCandidate[]) => ReapResult {
  const checks = new Map<string, { atMs: number; clean: boolean }>();
  const held = new Map<string, { atMs: number; message: string }>();
  const isClean = (ws: string): boolean => {
    const cached = checks.get(ws);
    if (cached && deps.now() - cached.atMs < GIT_RECHECK_MS) {
      return cached.clean;
    }
    const clean = deps.gitClean(ws);
    checks.set(ws, { atMs: deps.now(), clean });
    return clean;
  };
  return (candidates) => {
    const unsaved = new Set<string>();
    const faults = new Map<string, string>();
    const ended = new Set<string>();
    for (const c of candidates) {
      if (isOrchestrationTab(c.tab) || c.error !== undefined || c.fault !== undefined) continue;
      const fault = held.get(c.tab);
      if (fault && deps.now() - fault.atMs < GIT_RECHECK_MS) {
        faults.set(c.tab, fault.message);
        continue;
      }
      try {
        if (!deps.endedForGood(c.tab)) continue;
        ended.add(c.tab);
        if (!isClean(c.tab)) {
          unsaved.add(c.tab);
          continue;
        }
        deps.remove(c.tab);
        held.delete(c.tab);
      } catch (e) {
        const message = errorMessage(e);
        held.set(c.tab, { atMs: deps.now(), message });
        faults.set(c.tab, message);
      }
    }
    [...checks.keys()].filter((ws) => !ended.has(ws)).forEach((ws) => checks.delete(ws));
    [...held.keys()].filter((ws) => !faults.has(ws)).forEach((ws) => held.delete(ws));
    return { unsaved, faults };
  };
}
