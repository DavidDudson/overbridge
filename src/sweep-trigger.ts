import { selfCommand } from "./paths";
import { readState, withState } from "./state";
import { spawnCwd } from "./util";

/** How often the merged-PR sweep runs, across every sidebar together. */
export const MERGE_SWEEP_MS = 60_000;

/**
 * Take the merged-PR sweep for this interval, so one sidebar runs it and the others skip. Reads state first, so a sidebar that is not due
 * never takes the lock on its poll.
 */
export function claimSweep(now: number = Date.now(), intervalMs: number = MERGE_SWEEP_MS): boolean {
  const due = (at: number | undefined) => now - (at ?? 0) >= intervalMs;
  if (!due(readState().mergeSweepAt)) {
    return false;
  }
  return withState((s) => {
    if (!due(s.mergeSweepAt)) {
      return false;
    }
    s.mergeSweepAt = now;
    return true;
  });
}

/** Run `overbridge top sweep` detached, so slow `gh` calls never hold up the sidebar that started it. */
export function startSweep(): void {
  const proc = Bun.spawn({ cmd: [...selfCommand(), "top", "sweep"], cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true });
  proc.unref();
}
