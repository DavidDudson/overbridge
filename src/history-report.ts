import { COMMAND_CLASSES, historyStore, type HistoryStore, type Summary, summarize } from "./history";

/** `1h05m`, `4m12s`, `3.4s`, `120ms`: the shortest honest form of a duration. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** One workspace's summary over a window. */
export interface WorkspaceSummary {
  ws: string;
  summary: Summary;
}

/** Summaries for `only` (default: every workspace with history), over the last `windowMs` (default: all time). */
export function summaries(store: HistoryStore = historyStore(), windowMs?: number, only?: string, now = Date.now()): WorkspaceSummary[] {
  const since = windowMs === undefined ? 0 : now - windowMs;
  return (only ? [only] : store.workspaces()).map((ws) => ({ ws, summary: summarize(store.read(ws, since)) }));
}

/** The share of `part` in `whole`, as a whole percent. */
export const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

/** Plain-text lines for one workspace: the Claude split, then the check runs by class. */
export function summaryLines({ ws, summary: s }: WorkspaceSummary): string[] {
  const active = s.modelMs + s.toolMs + s.permissionMs + s.userMs;
  const lines = [
    `${ws}: ${s.turns} turn${s.turns === 1 ? "" : "s"}, ${duration(s.turnMs)} in turns`,
    `  claude   model ${duration(s.modelMs)} (${percent(s.modelMs, active)}%)  tools ${duration(s.toolMs)} (${percent(s.toolMs, active)}%)  ` +
      `permission ${duration(s.permissionMs)} (${percent(s.permissionMs, active)}%)  user ${duration(s.userMs)} (${percent(s.userMs, active)}%)` +
      (s.awayMs > 0 ? `  away ${duration(s.awayMs)}` : ""),
  ];
  const tools = Object.entries(s.tools).sort(([, a], [, b]) => b.ms - a.ms);
  if (tools.length) lines.push(`  tools    ${tools.slice(0, 5).map(([t, v]) => `${t} ${v.count}× ${duration(v.ms)}`).join("  ")}`);
  for (const cls of COMMAND_CLASSES) {
    const c = s.checks[cls];
    if (c) lines.push(`  check    ${cls} ${c.count}× ${duration(c.ms)}${c.failed ? ` (${c.failed} failed)` : ""}, queued ${duration(c.queuedMs)}`);
  }
  return lines;
}
