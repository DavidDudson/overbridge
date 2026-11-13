import type { Verdict } from "./merge-sweep";

/** What the server's sweep timer does, apart from the server, so tests fake every read. */
export interface SweeperDeps {
  /** Take this interval's sweep (`claimSweep`): sets `mergeSweepAt`, so the sidebar countdown and any fallback sweeper agree. */
  claim: (now: number) => boolean;
  /** Workspaces whose top cache is old enough to refresh. */
  stale: (now: number) => string[];
  /** Refresh one workspace's top cache through the server's own cache and batcher. */
  refresh: (ws: string) => Promise<unknown>;
  /**
   * The sweep itself (`sweepMerged`): decides from the caches, reads git directly and removes through `beginRemoval`.
   * `failed` holds the workspaces whose refresh threw, which the sweep must keep rather than judge from an old cache.
   */
  sweep: (failed: ReadonlyMap<string, Error>) => Record<string, Verdict>;
  now: () => number;
  log: (msg: string) => void;
}

export interface SweepStats {
  /** Sweeps run since the server started. */
  runs: number;
  running: boolean;
  /** When the last sweep started (ms since epoch), 0 before the first. */
  lastAt: number;
  lastMs: number;
  lastChecked: number;
  lastError?: string;
}

/**
 * One sweep per `MERGE_SWEEP_MS` for every sidebar together: `tick` is cheap when nothing is due, and a sweep that is still
 * running when the next one is due is skipped, never stacked.
 */
export function createSweeper(deps: SweeperDeps) {
  let running = false;
  const stats: SweepStats = { runs: 0, running: false, lastAt: 0, lastMs: 0, lastChecked: 0 };

  async function tick(): Promise<boolean> {
    if (running) return false;
    const started = deps.now();
    if (!deps.claim(started)) return false;
    running = true;
    stats.running = true;
    try {
      const failed = new Map<string, Error>();
      await Promise.all(
        deps.stale(started).map((ws) =>
          deps.refresh(ws).catch((e: unknown) => {
            failed.set(ws, e instanceof Error ? e : new Error(String(e)));
          }),
        ),
      );
      stats.lastChecked = Object.keys(deps.sweep(failed)).length;
      delete stats.lastError;
    } catch (e) {
      stats.lastError = e instanceof Error ? e.message : String(e);
      deps.log(`sweep failed: ${stats.lastError}`);
    } finally {
      stats.runs += 1;
      stats.lastAt = started;
      stats.lastMs = deps.now() - started;
      stats.running = false;
      running = false;
    }
    return true;
  }

  return {
    tick,
    stats: (): SweepStats => ({ ...stats }),
    get busy() {
      return running;
    },
  };
}
