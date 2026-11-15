import { type CommandClass, type CommandTally, type GroupTally, historyStore, type HistoryStore, type RepoSummary, type Summary, summarize, summarizeRepos, type Tally } from "./history";

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

/** Repos with the most check time first, then by name. */
export function rankedRepos(list: readonly RepoSummary[]): RepoSummary[] {
  return [...list].sort((a, b) => b.ms - a.ms || a.repo.localeCompare(b.repo));
}

/** Check runs per repo over the last `windowMs` (default: all time), from `only` (default: every workspace), busiest first. */
export function repoSummaries(store: HistoryStore = historyStore(), windowMs?: number, only?: string, now = Date.now()): RepoSummary[] {
  const since = windowMs === undefined ? 0 : now - windowMs;

  return rankedRepos(summarizeRepos((only ? [only] : store.workspaces()).flatMap((ws) => store.read(ws, since))));
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

/** A summary with nothing in it. */
export const emptySummary = (): Summary => ({ sessions: 0, turns: 0, turnMs: 0, modelMs: 0, toolMs: 0, permissionMs: 0, userMs: 0, awayMs: 0, tools: {}, bash: {}, commands: {}, skills: {}, checks: {}, groups: {} });

const addTally = <T extends Tally>(into: Record<string, T>, key: string, t: T, join: (a: T, b: T) => T) => {
  const prev = into[key];
  into[key] = prev ? join(prev, t) : { ...t };
};

const plus = (a: Tally, b: Tally) => ({ count: a.count + b.count, ms: a.ms + b.ms });

/** Sum summaries into one: the dashboard over every workspace. Tool time adds across workspaces, which run side by side. */
export function mergeSummaries(list: readonly Summary[]): Summary {
  const out = emptySummary();

  for (const s of list) {
    out.sessions += s.sessions ?? 0;
    out.turns += s.turns;
    out.turnMs += s.turnMs;
    out.modelMs += s.modelMs;
    out.toolMs += s.toolMs;
    out.permissionMs += s.permissionMs;
    out.userMs += s.userMs;
    out.awayMs += s.awayMs;

    for (const [k, t] of Object.entries(s.tools)) addTally(out.tools, k, t, plus);

    for (const [k, t] of Object.entries(s.skills ?? {})) addTally(out.skills, k, t, plus);

    for (const [k, t] of Object.entries(s.bash)) addTally(out.bash as Record<string, Tally>, k, t, plus);

    for (const [k, t] of Object.entries(s.commands ?? {})) addTally(out.commands, k, t, (a, b): CommandTally => ({ ...plus(a, b), cls: a.cls, failed: a.failed + b.failed, maxMs: Math.max(a.maxMs, b.maxMs) }));

    for (const [k, t] of Object.entries(s.checks)) {
      if (t) addTally(out.checks as Record<string, NonNullable<typeof t>>, k, t, (a, b) => ({ ...plus(a, b), failed: a.failed + b.failed, queuedMs: a.queuedMs + b.queuedMs }));
    }

    for (const [k, g] of Object.entries(s.groups)) {
      addTally(out.groups, k, g, (a, b): GroupTally => ({ ...plus(a, b), failed: a.failed + b.failed, queuedMs: a.queuedMs + b.queuedMs, cls: a.cls, maxMs: Math.max(a.maxMs ?? 0, b.maxMs ?? 0), fulls: [...new Set([...a.fulls, ...b.fulls])].slice(0, 3) }));
    }
  }

  return out;
}

/** One kind of command, from Claude's Bash tool or from `overbridge check`. */
export interface CommandRow {
  source: "bash" | "check";
  /** `bun test` for Bash, the group (`check`) for a check run. */
  label: string;
  cls: CommandClass;
  count: number;
  ms: number;
  maxMs: number;
  failed: number;
  /** Check queue wait; always 0 for Bash. */
  queuedMs: number;
  /** Whole command lines, check runs only. */
  fulls: string[];
}

/** Every command in the summary, Bash and check alike, slowest total first. */
export function commandRows(s: Summary): CommandRow[] {
  const bash = Object.entries(s.commands ?? {}).map(([label, c]): CommandRow => ({ source: "bash", label, cls: c.cls, count: c.count, ms: c.ms, maxMs: c.maxMs, failed: c.failed, queuedMs: 0, fulls: [] }));
  const checks = Object.entries(s.groups).map(([label, g]): CommandRow => ({ source: "check", label, cls: g.cls, count: g.count, ms: g.ms, maxMs: g.maxMs ?? 0, failed: g.failed, queuedMs: g.queuedMs, fulls: g.fulls }));

  return [...bash, ...checks].sort((a, b) => b.ms - a.ms || a.label.localeCompare(b.label));
}

/** Every view of the history for one window. */
export interface WindowView {
  workspaces: WorkspaceSummary[];
  repos: RepoSummary[];
  /** Every workspace's summary added up. */
  dashboard: Summary;
  /** Every command, Bash and check, slowest first. */
  commands: CommandRow[];
}

/** All windows' views from one read of each workspace's history. Pure over `store`. */
export function computeViews(store: HistoryStore = historyStore(), now = Date.now()): Record<string, WindowView> {
  const all = store.workspaces().map((ws) => ({ ws, records: store.read(ws) }));

  return Object.fromEntries(
    WINDOWS.map(({ label, ms }) => {
      const since = ms === undefined ? 0 : now - ms;
      const within = all.map(({ ws, records }) => ({ ws, records: records.filter((r) => r.at >= since) }));

      const workspaces = within.map(({ ws, records }) => ({ ws, summary: summarize(records) }));
      const dashboard = mergeSummaries(workspaces.map((w) => w.summary));

      return [label, { workspaces, repos: summarizeRepos(within.flatMap((w) => w.records)), dashboard, commands: commandRows(dashboard) }];
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

/** One plain-text line for a command row. */
export function commandLine(c: CommandRow): string {
  return `${c.label.padEnd(28)} ${c.source.padEnd(5)} ${c.cls.padEnd(9)} ${String(c.count).padStart(5)}× total ${duration(c.ms)} mean ${duration(c.count ? c.ms / c.count : 0)} worst ${duration(c.maxMs)}${c.failed ? ` ${c.failed} failed` : ""}${c.fulls[0] ? `  ${c.fulls[0]}` : ""}`;
}
