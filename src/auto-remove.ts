import { sessionEndedForGood } from "./agent-state";
import { isOrchestrationTab } from "./orchestration";
import { beginRemoval, Landing } from "./remove";
import { gitClean } from "./top";

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
}

const defaultDeps = (): ReapDeps => ({
  endedForGood: (ws) => sessionEndedForGood(ws),
  gitClean,
  remove: (ws) => beginRemoval(ws, { landing: Landing.IfFocused }),
  now: Date.now,
});

/**
 * A function for the sidebar poll that removes every workspace whose session the user closed on purpose and whose
 * git work is all pushed. It returns the ended workspaces it kept because they hold uncommitted or unpushed work.
 * Git checks are remembered for `GIT_RECHECK_MS`, because the sidebar polls every second.
 */
export function createReaper(deps: ReapDeps = defaultDeps()): (candidates: readonly ReapCandidate[]) => ReadonlySet<string> {
  const checks = new Map<string, { atMs: number; clean: boolean }>();
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
    const ended = candidates.filter((c) => !isOrchestrationTab(c.tab) && c.error === undefined && deps.endedForGood(c.tab)).map((c) => c.tab);
    [...checks.keys()].filter((ws) => !ended.includes(ws)).forEach((ws) => checks.delete(ws));
    const checked = ended.map((ws) => ({ ws, clean: isClean(ws) }));
    checked.filter((c) => c.clean).forEach((c) => deps.remove(c.ws));
    return new Set(checked.filter((c) => !c.clean).map((c) => c.ws));
  };
}
