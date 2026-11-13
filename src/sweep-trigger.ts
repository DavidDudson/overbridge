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

/** How long a sidebar trusts its last answer on whether the server runs the sweep. */
export const SERVER_CHECK_MS = 10_000;

export interface SweepTriggerDeps {
  /** Whether the server runs the sweep (it answered); resolves false when it is down or on another version. */
  serverOwns: () => Promise<boolean>;
  claim: (now: number) => boolean;
  start: () => void;
  now: () => number;
}

/**
 * The sidebar's sweep turn. While the server runs the sweep on its timer the sidebar does nothing; with the server down it
 * falls back to `claimSweep` and a detached `top sweep`. The server's answer is asked for at most every `SERVER_CHECK_MS`
 * and read on the next poll, so a poll never waits on a socket.
 */
export function createSweepTrigger(deps: SweepTriggerDeps): () => void {
  let owned = false;
  let checkedAt = -Infinity;
  let checking = false;
  return () => {
    const now = deps.now();
    if (!checking && now - checkedAt >= SERVER_CHECK_MS) {
      checking = true;
      checkedAt = now;
      deps
        .serverOwns()
        .then((v) => {
          owned = v;
        })
        .catch(() => {
          owned = false;
        })
        .finally(() => {
          checking = false;
        });
    }
    if (!owned && deps.claim(now)) deps.start();
  };
}
