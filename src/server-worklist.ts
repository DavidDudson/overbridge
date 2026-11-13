import { Cache, errorText, type CacheStats } from "./server-cache";
import { type BoardSource, mergeReads, type SourceRead, sourceKey, WORKLIST_REFRESH_MS } from "./worklist-run";

/**
 * The work list refreshed from the server: one read per board per window, however many panes ask, with the cache keys
 * `board:gh:<slug>:…` and `board:jira:<project>:…`. The reads run in workers (they shell out to `gh` and `jira`); the
 * plan and the write are the pane's own code, so `worklist.json` is what a child process would have written.
 */

export const BOARD_TTL_MS = WORKLIST_REFRESH_MS;
export const BOARD_STALE_MS = 10 * 60_000;

export interface WorklistDeps {
  plan: () => Promise<{ sources: BoardSource[]; notes: string[] }>;
  read: (source: BoardSource) => Promise<SourceRead>;
  /** Write `worklist.json` from the plan's notes and the merged reads. */
  finish: (notes: string[], read: SourceRead) => void;
  now?: () => number;
}

export function createWorklistRefresher(deps: WorklistDeps) {
  const boards = new Cache<SourceRead>({ maxInFlight: 4, ...(deps.now ? { now: deps.now } : {}) });
  const run = new Cache<number>({ maxInFlight: 1, ...(deps.now ? { now: deps.now } : {}) });
  const now = deps.now ?? Date.now;

  async function once(force: boolean): Promise<number> {
    const plan = await deps.plan();
    const reads = await Promise.all(
      plan.sources.map(async (s): Promise<SourceRead> => {
        try {
          // a failed read with an earlier one to serve is the earlier one: the panel never empties on an outage
          const got = await boards.get(
            sourceKey(s),
            async () => {
              // `readSource` folds a failed read into notes; as a value it would be cached as a good read for the whole window, so it fails the fetch instead
              const r = await deps.read(s);
              if (r.failedRepos.length) throw new Error(r.notes[0] ?? "read failed");
              return r;
            },
            { ttlMs: BOARD_TTL_MS, staleMs: BOARD_STALE_MS, force },
          );
          return got.error ? { ...got.value, notes: [...got.value.notes, `${s.kind === "github" ? s.repo : s.project}: ${got.error.split("\n")[0]} (showing the last read)`] } : got.value;
        } catch (e) {
          return { rows: [], notes: [errorText(e).startsWith(`${s.kind === "github" ? s.repo : s.project}:`) ? errorText(e).split("\n")[0]! : `${s.kind === "github" ? s.repo : s.project}: ${errorText(e).split("\n")[0]}`], failedRepos: s.kind === "github" ? [s.repo] : s.repos };
        }
      }),
    );
    deps.finish(plan.notes, mergeReads(reads));
    return now();
  }

  return {
    /** Refresh the list. Concurrent callers share one run; `force` starts a run after the call. */
    refresh: (force = false) => run.get("worklist", () => once(force), { ttlMs: BOARD_TTL_MS, staleMs: BOARD_STALE_MS, force }),
    stats: (): { run: CacheStats; boards: CacheStats } => ({ run: run.stats(), boards: boards.stats() }),
    get busy() {
      return run.busy || boards.busy;
    },
  };
}
