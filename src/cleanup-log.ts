import { type State, withState } from "./state";
import { MERGE_SWEEP_MS } from "./sweep-trigger";
import { type Color, colorize, fit } from "./term";

/** How a finished workspace removal ended. */
export const CleanupOutcome = { Removed: "removed", Failed: "failed" } as const;
export type CleanupOutcome = (typeof CleanupOutcome)[keyof typeof CleanupOutcome];

/** What removed a workspace: the Cleanup button, the merged-PR sweep, or the session-end reaper. */
export const CleanupCause = { Cleanup: "cleanup", Merged: "merged", SessionEnded: "session-ended" } as const;
export type CleanupCause = (typeof CleanupCause)[keyof typeof CleanupCause];

/** One finished removal, kept in state so every sidebar can list it. */
export interface CleanupRecord {
  ws: string;
  /** The sidebar label the workspace had, since its top cache goes with it. */
  label: string;
  atMs: number;
  outcome: CleanupOutcome;
  cause: CleanupCause;
}

/** A removal still in flight. */
export interface CleanupInFlight {
  label: string;
  sinceMs: number;
}

/** Records kept in state; older ones drop off. */
export const CLEANUP_LOG_LIMIT = 20;
/** Most cleanup rows the sidebar gives up from the workspace list. */
export const CLEANUP_ROWS = 3;

/** `log` with `record` added, newest last, capped at `CLEANUP_LOG_LIMIT`. */
export const appendCleanup = (log: readonly CleanupRecord[], record: CleanupRecord): CleanupRecord[] => [...log, record].slice(-CLEANUP_LOG_LIMIT);

/** Add `record` to the cleanup log in state. */
export function recordCleanup(record: CleanupRecord) {
  withState((s: State) => {
    s.cleanups = appendCleanup(s.cleanups ?? [], record);
  });
}

/** Seconds until the next merged-PR check, given when the last one ran; zero once it is due. */
export const secondsToCheck = (sweepAt: number | undefined, now: number, intervalMs = MERGE_SWEEP_MS): number =>
  Math.max(0, Math.ceil((intervalMs - (now - (sweepAt ?? 0))) / 1000));

const rowStyle = (r: CleanupRecord): { glyph: string; word: string; color: Color } =>
  r.outcome === CleanupOutcome.Failed ? { glyph: "✗", word: "failed", color: "red" } : { glyph: "🧹", word: "removed", color: "grey" };

/**
 * The cleanup rows under the sidebar's divider, each `inner` columns wide: a countdown to the next check, then the removals in flight, then
 * those finished since the last check (`sweepAt`), which drop off when the next check runs. At most `CLEANUP_ROWS` removal rows.
 */
export function cleanupRows(inFlight: readonly CleanupInFlight[], log: readonly CleanupRecord[], inner: number, now = Date.now(), sweepAt?: number): string[] {
  const timer = colorize(fit(`🧹 next check ${secondsToCheck(sweepAt, now)}s`, inner), "grey");
  const running = inFlight.map((r) => colorize(fit(`🧹 removing ${r.label}`, inner), "yellow"));
  const finished = log
    .filter((r) => r.atMs >= (sweepAt ?? 0))
    .toSorted((a, b) => b.atMs - a.atMs)
    .map((r) => {
      const style = rowStyle(r);
      return colorize(fit(`${style.glyph} ${style.word} ${r.label}`, inner), style.color);
    });
  return [timer, ...[...running, ...finished].slice(0, CLEANUP_ROWS)];
}
