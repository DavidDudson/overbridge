import { historyStore, type HistoryStore, type RepoSummary, type Summary, summarize, summarizeRepos } from "./history";

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

/** Time the user could be watching: Claude's own, plus waiting on the user. */
export const activeMs = (s: Summary) => s.modelMs + s.toolMs + s.permissionMs + s.userMs;

/** Check runs across every class. */
export const checkTotals = (s: Summary) => Object.values(s.checks).reduce((n, c) => ({ count: n.count + (c?.count ?? 0), ms: n.ms + (c?.ms ?? 0) }), { count: 0, ms: 0 });

/** The share of `part` in `whole`, in percent to one decimal. */
export const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** `12.4%`: `percent` as text. */
export const pct = (part: number, whole: number) => `${percent(part, whole).toFixed(1)}%`;

/** Check groups, slowest first. */
export const topGroups = (groups: Summary["groups"]) => Object.entries(groups).sort(([a, x], [b, y]) => y.ms - x.ms || a.localeCompare(b));

/** The windows the perf tab cycles through. */
export const WINDOWS: readonly { label: string; ms: number | undefined }[] = [
  { label: "1h", ms: 3600_000 },
  { label: "24h", ms: 24 * 3600_000 },
  { label: "7d", ms: 7 * 24 * 3600_000 },
  { label: "all", ms: undefined },
];

/** Every view of the history for one window. */
export interface WindowView {
  workspaces: WorkspaceSummary[];
  repos: RepoSummary[];
}

/** All windows' views from one read of each workspace's history. Pure over `store`. */
export function computeViews(store: HistoryStore = historyStore(), now = Date.now()): Record<string, WindowView> {
  const all = store.workspaces().map((ws) => ({ ws, records: store.read(ws) }));
  return Object.fromEntries(
    WINDOWS.map(({ label, ms }) => {
      const since = ms === undefined ? 0 : now - ms;
      const within = all.map(({ ws, records }) => ({ ws, records: records.filter((r) => r.at >= since) }));
      return [label, { workspaces: within.map(({ ws, records }) => ({ ws, summary: summarize(records) })), repos: summarizeRepos(within.flatMap((w) => w.records)) }];
    }),
  );
}

/** Plain-text lines for one repo: its check time by group, with each group's share. */
export function repoLines(r: RepoSummary): string[] {
  const lines = [`${r.repo}: ${r.count} check run${r.count === 1 ? "" : "s"}, ${duration(r.ms)} running, ${duration(r.queuedMs)} queued${r.failed ? `, ${r.failed} failed` : ""}`];
  for (const [group, g] of topGroups(r.groups)) {
    lines.push(`  ${group.padEnd(14)} ${g.count}× ${duration(g.ms)} (${pct(g.ms, r.ms)})${g.failed ? ` ${g.failed} failed` : ""}  queued ${duration(g.queuedMs)}  ${g.fulls[0] ?? ""}`);
  }
  return lines;
}

/** Plain-text lines for one workspace: the Claude split, then the check runs by class. */
export function summaryLines({ ws, summary: s }: WorkspaceSummary): string[] {
  const active = activeMs(s);
  const checkMs = checkTotals(s).ms;
  const lines = [
    `${ws}: ${s.turns} turn${s.turns === 1 ? "" : "s"}, ${duration(s.turnMs)} in turns`,
    `  claude   model ${duration(s.modelMs)} (${pct(s.modelMs, active)})  tools ${duration(s.toolMs)} (${pct(s.toolMs, active)})  ` +
      `permission ${duration(s.permissionMs)} (${pct(s.permissionMs, active)})  user ${duration(s.userMs)} (${pct(s.userMs, active)})` +
      (s.awayMs > 0 ? `  away ${duration(s.awayMs)}` : ""),
  ];
  const tools = Object.entries(s.tools).sort(([, a], [, b]) => b.ms - a.ms);
  if (tools.length) lines.push(`  tools    ${tools.slice(0, 5).map(([t, v]) => `${t} ${v.count}× ${duration(v.ms)}`).join("  ")}`);
  for (const [group, c] of topGroups(s.groups)) {
    lines.push(`  check    ${group} ${c.count}× ${duration(c.ms)} (${pct(c.ms, checkMs)})${c.failed ? ` (${c.failed} failed)` : ""}, queued ${duration(c.queuedMs)}`);
  }
  return lines;
}
