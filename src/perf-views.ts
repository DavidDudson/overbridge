import type { Summary, Tally } from "./history";
import { activeMs, checkTotals, type CommandRow, duration, pct, percent, topGroups } from "./history-report";
import { bold, boxBottom, boxRow, boxTop, colorize, dim, fit, inverse } from "./term";

/** Rows a list view's frame uses besides its body. */
export const VIEW_CHROME = 7;

/** Rows the dashboard frame uses besides its body: top border, legend, bottom border. */
const DASHBOARD_CHROME = 3;

/** The perf tab's views, in the order `v` cycles them. */
export const VIEWS = ["dashboard", "sessions", "commands"] as const;

export type View = (typeof VIEWS)[number];

/** The view after `view`. */
export const nextView = (view: View): View => VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length]!;

const BAR_WIDTH_CELLS = 20;

/** A bar `BAR_WIDTH_CELLS` cells wide filled to `part` of `whole`. */
export function bar(part: number, whole: number): string {
  const cells = whole > 0 ? Math.round((Math.min(part, whole) / whole) * BAR_WIDTH_CELLS) : 0;

  return "█".repeat(cells) + "░".repeat(BAR_WIDTH_CELLS - cells);
}

const byMs = <T extends Tally>(o: Partial<Record<string, T>>): [string, T][] => Object.entries(o).flatMap(([k, t]): [string, T][] => (t ? [[k, t]] : [])).sort(([a, x], [b, y]) => y.ms - x.ms || y.count - x.count || a.localeCompare(b));

const mean = (t: Tally) => (t.count > 0 ? t.ms / t.count : 0);

const section = (title: string) => bold(title);

/** One stat row: name, count, total time, share of `total` and mean. */
const tallyRow = (name: string, nameWidth: number, t: Tally, total: number) => `  ${name.slice(0, nameWidth).padEnd(nameWidth)} ${String(t.count).padStart(6)} ${duration(t.ms).padStart(8)} ${pct(t.ms, total).padStart(6)} ${duration(mean(t)).padStart(8)}`;

/** The dashboard as plain lines (colour aside): totals, where Claude's time went, then the top tools, Bash classes, checks, skills and slowest commands. */
export function dashboardLines(s: Summary, workspaces: number, commands: readonly CommandRow[]): string[] {
  const active = activeMs(s);
  const checks = checkTotals(s);
  const lines: string[] = [];

  if (s.turns === 0 && s.sessions === 0 && s.toolMs === 0 && checks.count === 0 && commands.length === 0) return [dim("no history yet: it fills as Claude and checks run")];

  lines.push(section("Totals"));
  lines.push(`  ${workspaces} workspace${workspaces === 1 ? "" : "s"} · ${s.sessions} session start${s.sessions === 1 ? "" : "s"} · ${s.turns} turn${s.turns === 1 ? "" : "s"} · ${duration(s.turnMs)} in turns · ${checks.count} check run${checks.count === 1 ? "" : "s"} (${duration(checks.ms)})`);
  lines.push("");
  lines.push(section("Where Claude's time went"));

  for (const [name, ms] of [["model", s.modelMs], ["tools", s.toolMs], ["permission", s.permissionMs], ["user", s.userMs]] as const) {
    lines.push(`  ${name.padEnd(11)} ${bar(ms, active)} ${pct(ms, active).padStart(6)} ${duration(ms).padStart(8)}`);
  }

  if (s.awayMs > 0) lines.push(dim(`  away ${duration(s.awayMs)} (gaps over 30m, not counted)`));
  const tools = byMs(s.tools);
  const toolTotal = tools.reduce((n, [, t]) => n + t.ms, 0);

  lines.push("");
  lines.push(section("Time in each tool"));

  if (!tools.length) lines.push(dim("  none yet"));
  else lines.push(dim(`  ${"tool".padEnd(18)} ${"calls".padStart(6)} ${"time".padStart(8)} ${"share".padStart(6)} ${"mean".padStart(8)}`));

  for (const [name, t] of tools.slice(0, 10)) lines.push(tallyRow(name, 18, t, toolTotal));

  const bash = byMs(s.bash);

  if (bash.length) {
    lines.push("");
    lines.push(section("Bash by kind"));

    const bashTotal = bash.reduce((n, [, x]) => n + x.ms, 0);

    for (const [cls, t] of bash) lines.push(tallyRow(cls, 18, t, bashTotal));
  }

  const groups = topGroups(s.groups);

  if (groups.length) {
    lines.push("");
    lines.push(section("Checks"));

    for (const [name, g] of groups.slice(0, 6)) lines.push(`${tallyRow(name, 18, g, checks.ms)}${g.failed ? colorize(`  ${g.failed} failed`, "red") : ""}${g.queuedMs > 0 ? dim(`  queued ${duration(g.queuedMs)}`) : ""}`);
  }

  const skills = byMs(s.skills);

  if (skills.length) {
    lines.push("");
    lines.push(section("Skills"));

    for (const [name, t] of skills.sort(([, a], [, b]) => b.count - a.count).slice(0, 8)) lines.push(`  ${name.slice(0, 32).padEnd(32)} ${String(t.count).padStart(4)}×`);
  }

  if (commands.length) {
    lines.push("");
    lines.push(section("Slowest commands (by worst run)"));

    for (const c of [...commands].sort((a, b) => b.maxMs - a.maxMs).slice(0, 5)) lines.push(`  ${c.label.slice(0, 28).padEnd(28)} ${c.source.padEnd(5)} ${c.cls.padEnd(9)} worst ${duration(c.maxMs).padStart(7)}  ${c.count}×`);
  }

  return lines;
}

/** The dashboard's `lines` as screen rows, scrolled by `offset`. */
export function renderDashboard(lines: readonly string[], offset: number, height: number, width: number, windowLabel: string, message = ""): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - DASHBOARD_CHROME);
  const rows: string[] = [boxTop(`Performance dashboard · ${windowLabel}`, width)];

  for (let i = 0; i < body; i++) rows.push(boxRow(fit(lines[offset + i] ?? "", inner)));
  rows.push(boxRow(message ? bold(fit(message, inner)) : dim(fit("j/k scroll   v view   w window   r reload   q quit", inner))));
  rows.push(boxBottom(width, `${lines.length} lines`));

  return rows;
}

/** Longest dashboard scroll for a height, so the pane can clamp the offset. */
export const dashboardMaxOffset = (lineCount: number, height: number) => Math.max(0, lineCount - Math.max(1, height - DASHBOARD_CHROME));

export type CommandSource = "all" | "bash" | "check";

export type CommandSort = "time" | "runs" | "worst" | "mean";

export const COMMAND_SOURCES: readonly CommandSource[] = ["all", "bash", "check"];

export const COMMAND_SORTS: readonly CommandSort[] = ["time", "runs", "worst", "mean"];

export const nextOf = <T>(all: readonly T[], v: T): T => all[(all.indexOf(v) + 1) % all.length]!;

/** The rows to list: only `source`, ordered by `sort` (largest first, then label). */
export function listCommands(rows: readonly CommandRow[], source: CommandSource, sort: CommandSort): CommandRow[] {
  const key = (r: CommandRow) => (sort === "runs" ? r.count : sort === "worst" ? r.maxMs : sort === "mean" ? (r.count ? r.ms / r.count : 0) : r.ms);

  return rows.filter((r) => source === "all" || r.source === source).sort((a, b) => key(b) - key(a) || a.label.localeCompare(b.label));
}

/** The commands view as screen rows; the selected row's whole command (check runs only) and queue wait show below. */
export function renderCommands(list: readonly CommandRow[], selected: number, offset: number, height: number, width: number, windowLabel: string, source: CommandSource, sort: CommandSort, message = ""): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - VIEW_CHROME);
  const header = `${"command".padEnd(28)} ${"from".padEnd(5)} ${"kind".padEnd(9)} ${"runs".padStart(5)} ${"total".padStart(8)} ${"mean".padStart(8)} ${"worst".padStart(8)} ${"fail".padStart(4)}`;
  const rows: string[] = [boxTop(`Commands · ${windowLabel} · ${source} · by ${sort}`, width), boxRow(dim(fit(header, inner)))];
  const visible = list.slice(offset, offset + body);

  for (const [i, c] of visible.entries()) {
    const line = `${c.label.slice(0, 28).padEnd(28)} ${c.source.padEnd(5)} ${c.cls.padEnd(9)} ${String(c.count).padStart(5)} ${duration(c.ms).padStart(8)} ${duration(c.count ? c.ms / c.count : 0).padStart(8)} ${duration(c.maxMs).padStart(8)} ${String(c.failed).padStart(4)}`;
    const text = fit(line, inner);
    rows.push(boxRow(offset + i === selected ? inverse(text) : text));
  }

  for (let i = visible.length; i < body; i++) rows.push(boxRow(list.length === 0 && i === 0 ? dim(fit("no commands yet: they fill as Claude runs Bash and `overbridge check` runs", inner)) : fit("", inner)));
  const c = list[selected];
  const total = list.reduce((n, r) => n + r.ms, 0);

  rows.push(boxRow(fit(c ? `what    ${c.source === "bash" ? "Claude Bash call" : "overbridge check run"}, kind ${c.cls}, ${percent(c.ms, total)}% of the listed time${c.queuedMs > 0 ? `, queued ${duration(c.queuedMs)}` : ""}` : "", inner)));
  rows.push(boxRow(fit(c ? (c.fulls.length ? `full    ${c.fulls.join("   ")}` : c.source === "bash" ? "full    not kept: Bash history stores only the leading words" : "") : "", inner)));
  rows.push(boxRow(fit(c && c.failed > 0 ? colorize(`failed  ${c.failed} of ${c.count} runs`, "red") : "", inner)));
  rows.push(boxRow(message ? bold(fit(message, inner)) : dim(fit("j/k move   v view   f from   o order   w window   r reload   q quit", inner))));
  rows.push(boxBottom(width, `${list.length} command${list.length === 1 ? "" : "s"}`));

  return rows;
}
