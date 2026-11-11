import { type AgentState, AT_REST, readAgentState } from "./agent-state";
import { isOrchestrationTab } from "./orchestration";
import { CleanupCause } from "./cleanup-log";
import { beginRemoval, Landing } from "./remove";
import { isRemoving, RemovalBlock, readState, withState, type WorkspaceState } from "./state";
import { MERGE_SWEEP_MS } from "./sweep-trigger";
import { claimedCache, noUnsavedWork, readTopCache, refreshTop, type TopCache } from "./top";
import { log } from "./util";

/** What the merged-PR sweep does with one workspace. */
export const Verdict = {
  /** Not every PR has merged, or the workspace is not the sweep's to remove. */
  Keep: "keep",
  /** Every PR merged, but a repo holds uncommitted changes or a HEAD other than its PR's head. */
  MergedUnsaved: "merged-unsaved",
  /** Every PR merged and nothing is unsaved, but the agent is still working. */
  Wait: "wait",
  Remove: "remove",
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export interface VerdictInput {
  ws: string;
  workspace: WorkspaceState;
  cache: Pick<TopCache, "merged">;
  agent: AgentState | undefined;
  /** Whether git holds no unsaved work; called only once every PR has merged. */
  clean: () => boolean;
}

/** Decide one workspace. Orchestration tabs, workspaces being removed and ones whose last removal failed are kept. */
export function verdictFor(input: VerdictInput): Verdict {
  const { ws, workspace, cache, agent, clean } = input;
  if (isOrchestrationTab(ws) || isRemoving(workspace) || workspace.removeError !== undefined || !cache.merged) {
    return Verdict.Keep;
  }
  if (!clean()) {
    return Verdict.MergedUnsaved;
  }
  return AT_REST.has(agent) ? Verdict.Remove : Verdict.Wait;
}

/** Every claimed branch has a PR, so the network check is worth making. */
export const everyClaimHasPr = (w: WorkspaceState): boolean => {
  const claims = Object.values(w.repos).filter((c) => c.branch);
  return claims.length > 0 && claims.every((c) => c.pr !== undefined);
};

export interface SweepDeps {
  refresh: (ws: string) => void;
  /** Start removing `ws`; returns a refusal message, or undefined once under way. */
  remove: (ws: string) => string | undefined;
  now: number;
}

const defaultSweepDeps = (): SweepDeps => ({
  refresh: (ws) => {
    refreshTop(ws);
  },
  remove: (ws) => beginRemoval(ws, { landing: Landing.IfFocused, cause: CleanupCause.Merged }),
  now: Date.now(),
});

/**
 * `overbridge top sweep`: refresh every workspace whose claims all have PRs, remove the ones whose PRs have all merged with nothing unsaved and the agent
 * at rest, and mark the ones held back by unsaved work. Returns each checked workspace's verdict.
 */
export function sweepMerged(deps: SweepDeps = defaultSweepDeps()): Record<string, Verdict> {
  const candidates = Object.entries(readState().workspaces)
    .filter(([ws, w]) => !isOrchestrationTab(ws) && !isRemoving(w) && everyClaimHasPr(w))
    .map(([ws]) => ws);
  const verdicts = Object.fromEntries(candidates.map((ws) => [ws, checkOne(ws, deps)] as const));
  recordBlocks(verdicts);
  Object.entries(verdicts)
    .filter(([, v]) => v === Verdict.Remove)
    .forEach(([ws]) => {
      const refusal = deps.remove(ws);
      log(refusal ?? `removing ${ws}: every PR has merged`);
    });
  return verdicts;
}

function checkOne(ws: string, deps: SweepDeps): Verdict {
  try {
    if (deps.now - readTopCache(ws).at >= MERGE_SWEEP_MS) {
      deps.refresh(ws);
    }
    const workspace = readState().workspaces[ws];
    if (!workspace) {
      return Verdict.Keep;
    }
    const cache = claimedCache(ws);
    return verdictFor({ ws, workspace, cache, agent: readAgentState(ws), clean: () => noUnsavedWork(ws, cache) });
  } catch (e) {
    log(`${ws}: merged-PR check failed: ${(e as Error).message}`);
    return Verdict.Keep;
  }
}

/** Set or clear each workspace's "merged · unsaved work" mark, writing state only when a mark changes. */
function recordBlocks(verdicts: Record<string, Verdict>) {
  const wanted = (ws: string) => (verdicts[ws] === Verdict.MergedUnsaved ? RemovalBlock.MergedUnsaved : undefined);
  const changed = (s: ReturnType<typeof readState>) => Object.entries(s.workspaces).filter(([ws, w]) => w.removalBlocked !== wanted(ws));
  if (!changed(readState()).length) {
    return;
  }
  withState((s) => {
    changed(s).forEach(([ws, w]) => {
      const { removalBlocked: _, ...rest } = w;
      const block = wanted(ws);
      s.workspaces[ws] = block ? { ...rest, removalBlocked: block } : rest;
    });
  });
}
