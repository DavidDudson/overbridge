import { COMMAND_CLASSES } from "./history";
import { duration, percent, summaries, type WorkspaceSummary } from "./history-report";
import { bold, boxBottom, boxRow, boxTop, colorize, decodeInput, dim, ENTER_SCREEN, fit, frame, inverse, LEAVE_SCREEN } from "./term";

/** Rows the frame uses besides the workspace rows: top border, header, detail (3), legend, bottom border. */
export const PERF_CHROME = 7;

/** The windows the `w` key cycles through. */
export const WINDOWS: readonly { label: string; ms: number | undefined }[] = [
  { label: "1h", ms: 3600_000 },
  { label: "24h", ms: 24 * 3600_000 },
  { label: "7d", ms: 7 * 24 * 3600_000 },
  { label: "all", ms: undefined },
];

export const PERF_REFRESH_MS = 5_000;

/** Workspaces with the most time first; those with no recorded time go last. */
export function ranked(list: readonly WorkspaceSummary[]): WorkspaceSummary[] {
  const total = ({ summary: s }: WorkspaceSummary) => s.turnMs + s.userMs + Object.values(s.checks).reduce((n, c) => n + (c?.ms ?? 0), 0);
  return [...list].sort((a, b) => total(b) - total(a) || a.ws.localeCompare(b.ws));
}

/** `name 34%` cells for the Claude split, so the columns line up. */
const split = (part: number, whole: number) => `${percent(part, whole)}%`.padStart(4);

/**
 * The tab as screen rows: a table with one row per workspace (Claude time split into model, tools, permission
 * prompts and the user; check runs), the selected workspace's slowest tools and checks, and a legend. Pure.
 */
export function renderPerf(list: readonly WorkspaceSummary[], selected: number, offset: number, height: number, width: number, windowLabel: string, message = ""): string[] {
  const inner = width - 4;
  const body = Math.max(1, height - PERF_CHROME);
  const header = `${"workspace".padEnd(22)} ${"turns".padStart(5)} ${"in turns".padStart(8)}  ${"model".padStart(5)} ${"tools".padStart(5)} ${"perm".padStart(5)} ${"user".padStart(5)}  ${"checks".padStart(6)} ${"check time".padStart(10)}`;
  const rows: string[] = [boxTop(`Performance · ${windowLabel}`, width), boxRow(dim(fit(header, inner)))];
  const visible = list.slice(offset, offset + body);
  for (const [i, { ws, summary: s }] of visible.entries()) {
    const active = s.modelMs + s.toolMs + s.permissionMs + s.userMs;
    const checks = Object.values(s.checks).reduce((n, c) => ({ count: n.count + (c?.count ?? 0), ms: n.ms + (c?.ms ?? 0) }), { count: 0, ms: 0 });
    const line = `${ws.slice(0, 22).padEnd(22)} ${String(s.turns).padStart(5)} ${duration(s.turnMs).padStart(8)}  ${split(s.modelMs, active)} ${split(s.toolMs, active)} ${split(s.permissionMs, active)} ${split(s.userMs, active)}  ${String(checks.count).padStart(6)} ${duration(checks.ms).padStart(10)}`;
    const text = fit(line, inner);
    rows.push(boxRow(offset + i === selected ? inverse(text) : text));
  }
  for (let i = visible.length; i < body; i++) rows.push(boxRow(list.length === 0 && i === 0 ? dim(fit("no history yet: it fills as Claude and checks run", inner)) : fit("", inner)));
  const chosen = list[selected]?.summary;
  const tools = chosen ? Object.entries(chosen.tools).sort(([, a], [, b]) => b.ms - a.ms).slice(0, 4) : [];
  const checks = chosen ? COMMAND_CLASSES.flatMap((cls) => (chosen.checks[cls] ? [[cls, chosen.checks[cls]!] as const] : [])).sort(([, a], [, b]) => b.ms - a.ms) : [];
  rows.push(boxRow(fit(tools.length ? `tools   ${tools.map(([t, v]) => `${t} ${v.count}× ${duration(v.ms)}`).join("   ")}` : "", inner)));
  rows.push(boxRow(fit(checks.length ? `checks  ${checks.map(([c, v]) => `${c} ${v.count}× ${duration(v.ms)}${v.failed ? colorize(` (${v.failed} failed)`, "red") : ""}`).join("   ")}` : "", inner)));
  rows.push(boxRow(fit(chosen && chosen.awayMs > 0 ? `away    ${duration(chosen.awayMs)} (gaps over 30m, not counted as waiting)` : "", inner)));
  rows.push(boxRow(message ? bold(fit(message, inner)) : dim(fit("j/k move   w window   r reload   q quit", inner))));
  rows.push(boxBottom(width, `${list.length} workspace${list.length === 1 ? "" : "s"}`));
  return rows;
}

/** `overbridge perf`: the @perf tab's pane. */
export async function perfPane() {
  let windowAt = 1;
  let selected = 0;
  let offset = 0;
  let list = ranked(summaries(undefined, WINDOWS[windowAt]!.ms));

  const reload = () => {
    list = ranked(summaries(undefined, WINDOWS[windowAt]!.ms));
  };
  const draw = () => {
    const height = process.stdout.rows ?? 24;
    const width = process.stdout.columns ?? 80;
    selected = Math.min(selected, Math.max(0, list.length - 1));
    const body = Math.max(1, height - PERF_CHROME);
    if (selected < offset) offset = selected;
    if (selected >= offset + body) offset = selected - body + 1;
    process.stdout.write(frame(renderPerf(list, selected, offset, height, width, WINDOWS[windowAt]!.label), height, width));
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
      else if (input.key === "j" || input.key === "down") selected = Math.min(list.length - 1, selected + 1);
      else if (input.key === "k" || input.key === "up") selected = Math.max(0, selected - 1);
      else if (input.key === "w") {
        windowAt = (windowAt + 1) % WINDOWS.length;
        reload();
      } else if (input.key === "r") reload();
    }
    draw();
  });
  process.stdout.on("resize", draw);
  setInterval(() => {
    reload();
    draw();
  }, PERF_REFRESH_MS);
  draw();
  await new Promise(() => {});
}
