import { type State, withState } from "./state";
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
/** How long a finished removal stays listed in the sidebar. */
export const CLEANUP_SHOW_MS = 60 * 60_000;
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

/** A short age: seconds under a minute, minutes under an hour, else hours. */
export function shortAge(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  if (secs < 60) {
    return `${secs}s`;
  }
  return secs < 3600 ? `${Math.floor(secs / 60)}m` : `${Math.floor(secs / 3600)}h`;
}

/** The word a removed row leads with, naming what removed it. */
const CAUSE_WORD: Record<CleanupCause, string> = {
  [CleanupCause.Cleanup]: "cleaned",
  [CleanupCause.Merged]: "merged",
  [CleanupCause.SessionEnded]: "exited",
};

const rowStyle = (r: CleanupRecord): { glyph: string; word: string; color: Color } =>
  r.outcome === CleanupOutcome.Failed ? { glyph: "✗", word: "failed", color: "red" } : { glyph: "🧹", word: CAUSE_WORD[r.cause], color: "grey" };

/**
 * The cleanup rows under the sidebar's divider, each `inner` columns wide: removals in flight first, then those
 * finished within `CLEANUP_SHOW_MS`, newest first, at most `CLEANUP_ROWS` in all. None when nothing was cleaned up lately.
 */
export function cleanupRows(inFlight: readonly CleanupInFlight[], log: readonly CleanupRecord[], inner: number, now = Date.now()): string[] {
  const running = inFlight.map((r) => colorize(fit(`🧹 ${shortAge(now - r.sinceMs)} removing ${r.label}`, inner), "yellow"));
  const finished = log
    .filter((r) => now - r.atMs < CLEANUP_SHOW_MS)
    .toSorted((a, b) => b.atMs - a.atMs)
    .map((r) => {
      const style = rowStyle(r);
      return colorize(fit(`${style.glyph} ${shortAge(now - r.atMs)} ${style.word} ${r.label}`, inner), style.color);
    });
  return [...running, ...finished].slice(0, CLEANUP_ROWS);
}
