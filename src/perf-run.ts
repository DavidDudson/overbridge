import type { RepoSummary } from "./history";
import { activeMs, checkTotals, duration, pct, rankedRepos, topGroups, WINDOWS, type WorkspaceSummary } from "./history-report";
import { computePerf, loadPerf, type PerfViews, readPerfCache } from "./perf-cache";
import { serverRefreshPerf } from "./server-client";
import { PERF_TAB } from "./sidebar";
import { createPainter, readView, shouldPoll } from "./zellij-view";
import { bold, boxBottom, boxRow, boxTop, colorize, decodeInput, dim, ENTER_SCREEN, fit, frame, inverse, LEAVE_SCREEN } from "./term";

/** Rows the frame uses besides the workspace rows: top border, header, detail (3), legend, bottom border. */
export const PERF_CHROME = 7;

export { rankedRepos, WINDOWS };

/** What a row is: one workspace, or one repo (its check runs from every workspace). */
export type Grouping = "workspace" | "repo";

export const PERF_REFRESH_MS = 5_000;

/** Workspaces with the most time first; those with no recorded time go last. */
export function ranked(list: readonly WorkspaceSummary[]): WorkspaceSummary[] {
  const total = ({ summary: s }: WorkspaceSummary) => s.turnMs + s.userMs + checkTotals(s).ms;
  return [...list].sort((a, b) => total(b) - total(a) || a.ws.localeCompare(b.ws));
}

/** `34.2%` cells for the Claude split, so the columns line up. */
const split = (part: number, whole: number) => pct(part, whole).padStart(6);

/**
 * The tab as screen rows: a table with one row per workspace (Claude time split into model, tools, permission
 * prompts and the user; check runs), the selected workspace's slowest tools and checks, and a legend. Pure.
 */
export function renderPerf(list: readonly WorkspaceSummary[], selected: number, offset: number, height: number, width: number, windowLabel: string, message = ""): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - PERF_CHROME);
  const header = `${"workspace".padEnd(22)} ${"turns".padStart(5)} ${"in turns".padStart(8)}  ${"model".padStart(6)} ${"tools".padStart(6)} ${"perm".padStart(6)} ${"user".padStart(6)}  ${"checks".padStart(6)} ${"check time".padStart(10)}`;
  const rows: string[] = [boxTop(`Performance · ${windowLabel}`, width), boxRow(dim(fit(header, inner)))];
  const visible = list.slice(offset, offset + body);
  for (const [i, { ws, summary: s }] of visible.entries()) {
    const active = activeMs(s);
    const checks = checkTotals(s);
    const line = `${ws.slice(0, 22).padEnd(22)} ${String(s.turns).padStart(5)} ${duration(s.turnMs).padStart(8)}  ${split(s.modelMs, active)} ${split(s.toolMs, active)} ${split(s.permissionMs, active)} ${split(s.userMs, active)}  ${String(checks.count).padStart(6)} ${duration(checks.ms).padStart(10)}`;
    const text = fit(line, inner);
    rows.push(boxRow(offset + i === selected ? inverse(text) : text));
  }
  for (let i = visible.length; i < body; i++) rows.push(boxRow(list.length === 0 && i === 0 ? dim(fit("no history yet: it fills as Claude and checks run", inner)) : fit("", inner)));
  const chosen = list[selected]?.summary;
  const tools = chosen ? Object.entries(chosen.tools).sort(([, a], [, b]) => b.ms - a.ms).slice(0, 4) : [];
  const checkMs = chosen ? checkTotals(chosen).ms : 0;
  const byGroup = chosen ? topGroups(chosen.groups) : [];
  rows.push(boxRow(fit(tools.length ? `tools   ${tools.map(([t, v]) => `${t} ${v.count}× ${duration(v.ms)}`).join("   ")}` : "", inner)));
  rows.push(boxRow(fit(byGroup.length ? `checks  ${byGroup.map(([c, v]) => `${c} ${v.count}× ${duration(v.ms)} ${pct(v.ms, checkMs)}${v.failed ? colorize(` (${v.failed} failed)`, "red") : ""}`).join("   ")}` : "", inner)));
  rows.push(boxRow(fit(chosen && chosen.awayMs > 0 ? `away    ${duration(chosen.awayMs)} (gaps over 30m, not counted as waiting)` : "", inner)));
  rows.push(boxRow(message ? bold(fit(message, inner)) : dim(fit("j/k move   w window   g by repo   r reload   q quit", inner))));
  rows.push(boxBottom(width, `${list.length} workspace${list.length === 1 ? "" : "s"}`));
  return rows;
}

/**
 * The repo view as screen rows: one row per repo with its check runs (count, run time, queue wait, failures), and for
 * the selected repo each group's exact share of its check time, then the full command of each of its slowest groups. Pure.
 */
export function renderRepos(list: readonly RepoSummary[], selected: number, offset: number, height: number, width: number, windowLabel: string, message = ""): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - PERF_CHROME);
  const header = `${"repo".padEnd(22)} ${"runs".padStart(5)} ${"run time".padStart(9)} ${"queued".padStart(9)} ${"failed".padStart(6)}  slowest group`;
  const rows: string[] = [boxTop(`Performance by repo · ${windowLabel}`, width), boxRow(dim(fit(header, inner)))];
  const visible = list.slice(offset, offset + body);
  for (const [i, r] of visible.entries()) {
    const [name, g] = topGroups(r.groups)[0] ?? ["", undefined];
    const line = `${r.repo.slice(0, 22).padEnd(22)} ${String(r.count).padStart(5)} ${duration(r.ms).padStart(9)} ${duration(r.queuedMs).padStart(9)} ${String(r.failed).padStart(6)}  ${name} ${g ? pct(g.ms, r.ms) : ""}`;
    const text = fit(line, inner);
    rows.push(boxRow(offset + i === selected ? inverse(text) : text));
  }
  for (let i = visible.length; i < body; i++) rows.push(boxRow(list.length === 0 && i === 0 ? dim(fit("no check runs yet: they fill as `overbridge check` runs", inner)) : fit("", inner)));
  const chosen = list[selected];
  const groups = chosen ? topGroups(chosen.groups) : [];
  const total = chosen?.ms ?? 0;
  rows.push(boxRow(fit(groups.length ? `groups  ${groups.slice(0, 5).map(([n, g]) => `${n} ${g.count}× ${duration(g.ms)} ${pct(g.ms, total)}${g.failed ? colorize(` (${g.failed} failed)`, "red") : ""}`).join("   ")}` : "", inner)));
  rows.push(boxRow(fit(groups.length ? `command ${groups.slice(0, 3).map(([n, g]) => `${n}: ${g.fulls[0] ?? n}`).join("   ")}` : "", inner)));
  rows.push(boxRow(fit(groups.length ? `queued  ${groups.slice(0, 5).map(([n, g]) => `${n} ${duration(g.queuedMs)}`).join("   ")}` : "", inner)));
  rows.push(boxRow(message ? bold(fit(message, inner)) : dim(fit("j/k move   w window   g by workspace   r reload   q quit", inner))));
  rows.push(boxBottom(width, `${list.length} repo${list.length === 1 ? "" : "s"}`));
  return rows;
}

/** The rows on screen, tagged with what they are, so the renderer needs no cast. */
export type PerfList = { grouping: "repo"; rows: readonly RepoSummary[] } | { grouping: "workspace"; rows: readonly WorkspaceSummary[] };

/** `overbridge perf`: the @perf tab's pane. */
export async function perfPane() {
  let windowAt = 1;
  let selected = 0;
  let offset = 0;
  let grouping: Grouping = "workspace";
  let views: PerfViews = loadPerf();
  const window = () => views.windows[WINDOWS[windowAt]!.label] ?? { workspaces: [], repos: [] };
  const rows = (): PerfList => (grouping === "repo" ? { grouping, rows: rankedRepos(window().repos) } : { grouping, rows: ranked(window().workspaces) });
  let list = rows();

  let reloadedAtMs = Date.now();
  let reloading = false;
  const painter = createPainter((text) => process.stdout.write(text));
  const draw = () => {
    const height = process.stdout.rows ?? 24;
    const width = process.stdout.columns ?? 80;
    selected = Math.min(selected, Math.max(0, list.rows.length - 1));
    const body = Math.max(1, height - PERF_CHROME);
    if (selected < offset) offset = selected;
    if (selected >= offset + body) offset = selected - body + 1;
    const label = WINDOWS[windowAt]!.label;
    const screen = list.grouping === "repo" ? renderRepos(list.rows, selected, offset, height, width, label) : renderPerf(list.rows, selected, offset, height, width, label);
    painter.paint(frame(screen, height, width));
  };
  /** Ask the server for fresh views (`force`: a rebuild that starts now, for the user's `r`), else compute them here. */
  const reload = async (force: boolean) => {
    if (reloading) return;
    reloading = true;
    reloadedAtMs = Date.now();
    try {
      const built = await serverRefreshPerf(force ? { force } : {});
      views = (built ? readPerfCache() : undefined) ?? computePerf();
      list = rows();
    } finally {
      reloading = false;
    }
    draw();
  };
  const quit = () => {
    process.stdout.write(LEAVE_SCREEN);
    process.stdin.setRawMode?.(false);
    process.exit(0);
  };

  process.stdout.write(ENTER_SCREEN);
  process.stdin.setRawMode?.(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (data: string) => {
    for (const input of decodeInput(data)) {
      if (input.kind !== "key") continue;
      if (input.key === "q" || input.key === "ctrl-c") quit();
      else if (input.key === "j" || input.key === "down") selected = Math.max(0, Math.min(list.rows.length - 1, selected + 1));
      else if (input.key === "k" || input.key === "up") selected = Math.max(0, selected - 1);
      else if (input.key === "g") {
        grouping = grouping === "repo" ? "workspace" : "repo";
        selected = offset = 0;
        list = rows();
      } else if (input.key === "w") {
        // every window is in the views already
        windowAt = (windowAt + 1) % WINDOWS.length;
        list = rows();
      } else if (input.key === "r") void reload(true);
    }
    draw();
  });
  process.stdout.on("resize", () => {
    painter.invalidate();
    draw();
  });
  // a hidden tab reloads only now and then (shouldPoll), and an unchanged frame is not written
  setInterval(() => {
    if (shouldPoll(PERF_TAB, readView(), reloadedAtMs, Date.now())) void reload(false);
  }, PERF_REFRESH_MS);
  draw();
  await new Promise(() => {});
}
