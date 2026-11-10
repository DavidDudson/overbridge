import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentState, glyphFor, readAgentState } from "./agent-state";
import { requireWs } from "./commands";
import { metaDir } from "./paths";
import { type Limits, limitRows, readLimits } from "./limits";
import { next } from "./next";
import { readState } from "./state";
import { boxBottom, boxDivider, boxRow, boxTop, type Color, colorize, decodeInput, dim, ENTER_SCREEN, fit, frame, type Input, inverse, LEAVE_SCREEN, textWidth } from "./term";
import { readTopCache } from "./top";
import { sidebarLabel } from "./top";
import { naturalSort, run } from "./util";
import { overbridgeVersion } from "./version";
export const LEGEND = "⌥1-9 go  ⌥w next";

/**
 * The vertical tab sidebar. Every tab runs its own copy, which marks its own tab as current.
 * Moving to another tab switches there and focuses that tab's sidebar, so the next keypress
 * keeps stepping.
 */

const POLL_MS = 1_000;

export interface Entry {
  ws: string;
  /** Agent state glyph. */
  glyph: string;
  state?: AgentState | undefined;
  /** Item id and title when known, else the workspace name. */
  label: string;
}

export { sidebarLabel, stripConventional } from "./top";

/** Workspace names in zellij's tab order; empty outside zellij. */
export function tabOrder(exec: (cmd: string[]) => { ok: boolean; stdout: string } = (cmd) => run(cmd)): string[] {
  const r = exec(["zellij", "action", "query-tab-names"]);
  return r.ok ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
}

/** The workspace whose tab is focused; undefined outside zellij. */
export function currentTab(exec: (cmd: string[]) => { ok: boolean; stdout: string } = (cmd) => run(cmd)): string | undefined {
  const r = exec(["zellij", "action", "current-tab-info"]);
  return r.ok ? /^name: (.+)$/m.exec(r.stdout)?.[1]?.trim() : undefined;
}

/** Entries for every workspace, in tab order so the Alt+digit keys match the digits shown. */
export function entries(order: string[] = tabOrder()): Entry[] {
  const names = Object.keys(readState().workspaces).sort(naturalSort);
  const rank = (ws: string) => { const i = order.indexOf(ws); return i < 0 ? order.length : i; };
  return [...names].sort((a, b) => rank(a) - rank(b)).map((ws) => {
    const state = readAgentState(ws);
    return { ws, glyph: glyphFor(state), state, label: sidebarLabel(ws, readTopCache(ws)) };
  });
}

/** Rows between the top border and the divider for a pane `height` rows tall. */
export const bodyRowsFor = (height: number) => Math.max(1, height - CHROME_TOP - CHROME_BOTTOM);

/** The scroll offset closest to `offset` that shows entry `selected`, given each entry's row `heights`. */
export function scrollFor(selected: number, offset: number, heights: number[], rows: number): number {
  if (selected < offset) return selected;
  let start = offset;
  const span = () => heights.slice(start, selected + 1).reduce((n, h) => n + h, 0);
  while (start < selected && span() > rows) start++;
  return start;
}

/** Pull `offset` back so the list never leaves blank rows below it while earlier entries are hidden. */
export function clampScroll(offset: number, heights: number[], rows: number): number {
  let start = Math.max(0, Math.min(offset, heights.length - 1));
  const span = (from: number) => heights.slice(from).reduce((n, h) => n + h, 0);
  while (start > 0 && span(start - 1) <= rows) start--;
  return start;
}

/** Rows above the list (top border) and below it (divider, two limit rows, key legend, bottom border). */
export const CHROME_TOP = 1;
export const CHROME_BOTTOM = 5;
/** Longest a title may wrap to. */
const MAX_TITLE_ROWS = 3;

const STATE_TEXT: Record<AgentState, { text: string; color: Color }> = {
  waiting: { text: "needs your input", color: "yellow" },
  empty: { text: "empty · can clean up", color: "grey" },
  done: { text: "finished", color: "green" },
  bg: { text: "finished · tasks running", color: "cyan" },
  busy: { text: "working", color: "blue" },
  idle: { text: "idle", color: "grey" },
  end: { text: "ended", color: "red" },
};

/** `text` broken at spaces into lines of at most `width` columns; an over-long word is split. */
export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  const push = () => { if (line) lines.push(line); line = ""; };
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while (textWidth(rest) > width) {
      push();
      let head = "";
      for (const ch of rest) {
        if (textWidth(head + ch) > width) break;
        head += ch;
      }
      if (!head) break;
      lines.push(head);
      rest = rest.slice(head.length);
    }
    if (!rest) continue;
    if (!line) line = rest;
    else if (textWidth(line) + 1 + textWidth(rest) <= width) line += ` ${rest}`;
    else { push(); line = rest; }
  }
  push();
  return lines.length ? lines : [""];
}

/** The unstyled title rows of an entry: the digit hint and glyph lead the first, the rest are indented under the text. */
function titleRows(e: Entry, index: number, inner: number): string[] {
  const digit = index < 9 ? `⌥${index + 1}` : "  ";
  const lead = `${digit} ${e.glyph} `;
  const lines = wrapText(e.label, Math.max(1, inner - textWidth(lead)));
  const clipped = lines.length > MAX_TITLE_ROWS ? [...lines.slice(0, MAX_TITLE_ROWS - 1), `${lines.slice(MAX_TITLE_ROWS - 1).join(" ")}`] : lines;
  return clipped.map((l, i) => (i === 0 ? lead : " ".repeat(textWidth(lead))) + l);
}

/** Screen rows one entry takes: its wrapped title and a status line. */
export const entryHeight = (e: Entry, index: number, inner: number) => titleRows(e, index, inner).length + 1;

/** Row heights for the whole list in a pane `width` columns wide. */
export const entryHeights = (list: Entry[], width: number) => list.map((e, i) => entryHeight(e, i, Math.max(1, width - 4)));

/** The rows of one entry, each `inner` columns wide: the current one inverse, others with a coloured status line. */
export function entryLines(e: Entry, index: number, selected: boolean, inner: number): string[] {
  const titles = titleRows(e, index, inner).map((l) => fit(l, inner));
  const status = e.state ? STATE_TEXT[e.state] : undefined;
  const indent = " ".repeat(3 + textWidth(e.glyph) + 1);
  const sub = fit(`${indent}${status?.text ?? ""}`, inner);
  if (selected) return [...titles, sub].map(inverse);
  return [...titles, status ? colorize(sub, status.color) : sub];
}

/**
 * The whole sidebar as `height` rows of `width` columns: a rounded frame titled "Workspaces" with
 * a padded card per workspace (title wraps), then a divider, the usage limits and the key legend,
 * with `version` set into the bottom border.
 */
export function renderSidebar(list: Entry[], current: number, offset: number, height: number, width: number, limits: Limits | undefined, now = Date.now(), version = ""): string[] {
  const inner = Math.max(0, width - 4);
  const bodyRows = Math.max(0, height - CHROME_TOP - CHROME_BOTTOM);
  const body: string[] = [];
  for (let i = offset; i < list.length && body.length < bodyRows; i++) body.push(...entryLines(list[i]!, i, i === current, inner));
  while (body.length < bodyRows) body.push(" ".repeat(inner));
  return [
    boxTop("Workspaces", width),
    ...body.slice(0, bodyRows).map(boxRow),
    boxDivider(width),
    ...limitRows(limits, inner, now).map(boxRow),
    boxRow(dim(fit(LEGEND, inner))),
    boxBottom(width, version, "grey"),
  ];
}

/** The entry index under screen row `row`, given each entry's row `heights`; undefined for none. */
export function entryAt(row: number, offset: number, heights: number[], rows: number): number | undefined {
  let y = CHROME_TOP;
  for (let i = offset; i < heights.length; i++) {
    if (y + heights[i]! > CHROME_TOP + rows) return undefined;
    if (row < y + heights[i]!) return row >= y ? i : undefined;
    y += heights[i]!;
  }
  return undefined;
}

/**
 * Which tab an input asks for, as an entry index; undefined for none or for the current one.
 * Up/`k` and down/`j` step (no wrap), a digit jumps, a click picks a row.
 */
export function targetFor(input: Input, current: number, offset: number, heights: number[], rows: number): number | undefined {
  const count = heights.length;
  let target: number | undefined;
  if (input.kind === "click") target = entryAt(input.row, offset, heights, rows);
  else if (input.key === "up" || input.key === "k") target = current - 1;
  else if (input.key === "down" || input.key === "j") target = current + 1;
  else if (/^[1-9]$/.test(input.key)) target = Number(input.key) - 1;
  return target !== undefined && target >= 0 && target < count && target !== current ? target : undefined;
}

/** Each sidebar records its zellij pane id here, so another tab's sidebar can focus it. */
const paneFile = (ws: string) => join(metaDir(), "sidebars", ws);

function registerPane(ws: string) {
  const id = process.env.ZELLIJ_PANE_ID;
  if (id === undefined) return;
  mkdirSync(join(metaDir(), "sidebars"), { recursive: true });
  writeFileSync(paneFile(ws), id);
}

const sidebarPane = (ws: string): string | undefined => {
  try {
    return readFileSync(paneFile(ws), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
};

/** Switch to `ws`'s tab and focus its sidebar. */
export function switchTab(ws: string, exec: (cmd: string[]) => unknown = (cmd) => run(cmd)) {
  exec(["zellij", "action", "go-to-tab-name", ws]);
  const pane = sidebarPane(ws);
  if (pane !== undefined) exec(["zellij", "action", "focus-pane-id", `terminal_${pane}`]);
}

/** `overbridge sidebar [--ws]`. `q` or Ctrl-C quits. */
export async function sidebar(wsOpt?: string) {
  const self = requireWs(wsOpt);
  if (!process.stdin.isTTY) throw new Error("overbridge sidebar needs a terminal");
  registerPane(self);

  // Read once at start, so a pane left running across an upgrade shows the version it runs.
  const version = overbridgeVersion();
  let offset = 0;
  const size = () => ({ height: process.stdout.rows ?? 24, width: process.stdout.columns ?? 28 });
  const draw = () => {
    const list = entries();
    const current = Math.max(0, list.findIndex((e) => e.ws === self));
    const { height, width } = size();
    const heights = entryHeights(list, width);
    const rows = bodyRowsFor(height);
    offset = clampScroll(scrollFor(current, offset, heights, rows), heights, rows);
    process.stdout.write(frame(renderSidebar(list, current, offset, height, width, readLimits(), Date.now(), version), height, width));
  };

  await new Promise<void>((resolve) => {
    const quit = () => {
      clearInterval(timer);
      process.stdout.write(LEAVE_SCREEN);
      process.stdin.setRawMode(false);
      rmSync(paneFile(self), { force: true });
      resolve();
    };
    process.stdout.write(ENTER_SCREEN);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", (buf) => {
      for (const input of decodeInput(buf.toString())) {
        if (input.kind === "key" && (input.key === "q" || input.key === "ctrl-c")) return quit();
        if (input.kind === "key" && input.key === "n") {
          next(self);
          continue;
        }
        const list = entries();
        const current = list.findIndex((e) => e.ws === self);
        const { height, width } = size();
        const target = targetFor(input, current, offset, entryHeights(list, width), bodyRowsFor(height));
        if (target !== undefined) switchTab(list[target]!.ws);
      }
    });
    process.stdout.on("resize", draw);
    const timer = setInterval(draw, POLL_MS);
    draw();
  });
}
