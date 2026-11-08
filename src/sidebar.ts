import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentState, glyphFor, readAgentState } from "./agent-state";
import { requireWs } from "./commands";
import { metaDir } from "./paths";
import { type Limits, limitRows, readLimits } from "./limits";
import { next } from "./next";
import { readState } from "./state";
import { boxBottom, boxDivider, boxRow, boxTop, type Color, colorize, decodeInput, dim, ENTER_SCREEN, fit, frame, type Input, inverse, LEAVE_SCREEN, textWidth } from "./term";
import { readTopCache, type TopCache } from "./top";
import { naturalSort, run } from "./util";
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

const CONVENTIONAL = /^(?:feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(?:\([^)]*\))?!?:\s*/i;

/** A title without its conventional-commit prefix: `feat(scope): add x` is `add x`. */
export const stripConventional = (title: string): string => title.replace(CONVENTIONAL, "").trim() || title;

/**
 * What the sidebar shows for a workspace: the item's title with no id and no conventional prefix,
 * else the workspace name when no title is cached yet.
 */
export function sidebarLabel(ws: string, cache: Pick<TopCache, "headline" | "title">): string {
  const title = cache.title ?? (cache.headline?.includes(" ") ? cache.headline.replace(/^\S+\s+/, "") : undefined);
  return title ? stripConventional(title) : ws;
}

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

/** The scroll offset closest to `offset` that shows row `selected` in a window of `height` rows. */
export function scrollFor(selected: number, offset: number, height: number): number {
  if (height <= 0) return 0;
  if (selected < offset) return selected;
  if (selected >= offset + height) return selected - height + 1;
  return offset;
}

/** Keep `offset` valid for a list of `count` rows in `height` rows. */
export const clampScroll = (offset: number, count: number, height: number) => Math.max(0, Math.min(offset, count - height));

/** Screen rows one workspace takes: its title line and a status line. */
export const ENTRY_ROWS = 2;
/** Rows above the list (top border) and below it (divider, two limit rows, key legend, bottom border). */
export const CHROME_TOP = 1;
export const CHROME_BOTTOM = 5;

/** Workspaces that fit in a pane `height` rows tall; always at least one. */
export const visibleEntries = (height: number) => Math.max(1, Math.floor((height - CHROME_TOP - CHROME_BOTTOM) / ENTRY_ROWS));

const STATE_TEXT: Record<AgentState, { text: string; color: Color }> = {
  waiting: { text: "needs your input", color: "yellow" },
  empty: { text: "empty · can clean up", color: "grey" },
  done: { text: "finished", color: "green" },
  bg: { text: "finished · tasks running", color: "cyan" },
  busy: { text: "working", color: "blue" },
  idle: { text: "idle", color: "grey" },
  end: { text: "ended", color: "red" },
};

/** The two lines of one entry, each `inner` columns wide: the current one inverse, others with a coloured status line. */
export function entryLines(e: Entry, index: number, selected: boolean, inner: number): string[] {
  const digit = index < 9 ? `⌥${index + 1}` : "  ";
  const title = fit(`${digit} ${e.glyph} ${e.label}`, inner);
  const status = e.state ? STATE_TEXT[e.state] : undefined;
  const indent = " ".repeat(3 + textWidth(e.glyph) + 1);
  const sub = fit(`${indent}${status?.text ?? ""}`, inner);
  if (selected) return [inverse(title), inverse(sub)];
  return [title, status ? colorize(sub, status.color) : sub];
}

/**
 * The whole sidebar as `height` rows of `width` columns: a rounded frame titled "Workspaces" with
 * a padded two-line card per workspace, then a divider, the usage limits and the key legend.
 */
export function renderSidebar(list: Entry[], current: number, offset: number, height: number, width: number, limits: Limits | undefined, now = Date.now()): string[] {
  const inner = Math.max(0, width - 4);
  const bodyRows = Math.max(0, height - CHROME_TOP - CHROME_BOTTOM);
  const body = list
    .slice(offset, offset + visibleEntries(height))
    .flatMap((e, i) => entryLines(e, offset + i, offset + i === current, inner));
  while (body.length < bodyRows) body.push(" ".repeat(inner));
  return [
    boxTop("Workspaces", width),
    ...body.slice(0, bodyRows).map(boxRow),
    boxDivider(width),
    ...limitRows(limits, inner, now).map(boxRow),
    boxRow(dim(fit(LEGEND, inner))),
    boxBottom(width),
  ];
}

/** The entry index under screen row `row`, if any; `visible` is how many entries are on screen. */
export function entryAt(row: number, offset: number, count: number, visible = count): number | undefined {
  const slot = Math.floor((row - CHROME_TOP) / ENTRY_ROWS);
  const index = offset + slot;
  return row >= CHROME_TOP && slot < visible && index < count ? index : undefined;
}

/**
 * Which tab an input asks for, as an entry index; undefined for none or for the current one.
 * Up/`k` and down/`j` step (no wrap), a digit jumps, a click picks a row.
 */
export function targetFor(input: Input, current: number, offset: number, count: number, visible = count): number | undefined {
  let target: number | undefined;
  if (input.kind === "click") target = entryAt(input.row, offset, count, visible);
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

  let offset = 0;
  const size = () => ({ height: process.stdout.rows ?? 24, width: process.stdout.columns ?? 28 });
  const draw = () => {
    const list = entries();
    const current = Math.max(0, list.findIndex((e) => e.ws === self));
    const { height, width } = size();
    const visible = visibleEntries(height);
    offset = clampScroll(scrollFor(current, offset, visible), list.length, visible);
    process.stdout.write(frame(renderSidebar(list, current, offset, height, width, readLimits()), height, width));
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
        const target = targetFor(input, current, offset, list.length, visibleEntries(size().height));
        if (target !== undefined) switchTab(list[target]!.ws);
      }
    });
    process.stdout.on("resize", draw);
    const timer = setInterval(draw, POLL_MS);
    draw();
  });
}
