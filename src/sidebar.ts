import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { glyphFor, readAgentState } from "./agent-state";
import { requireWs } from "./commands";
import { metaDir } from "./paths";
import { readState } from "./state";
import { decodeInput, ENTER_SCREEN, fit, frame, type Input, inverse, LEAVE_SCREEN } from "./term";
import { readTopCache } from "./top";
import { naturalSort, run } from "./util";

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
  /** Item id and title when known, else the workspace name. */
  label: string;
}

/** Entries for every workspace, in tab order. */
export function entries(): Entry[] {
  return Object.keys(readState().workspaces)
    .sort(naturalSort)
    .map((ws) => ({ ws, glyph: glyphFor(readAgentState(ws)), label: readTopCache(ws).headline ?? ws }));
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

/** The visible rows, styled: the current tab inverse, a digit (1-9) to jump to each of the first nine. */
export function sidebarRows(list: Entry[], current: number, offset: number, height: number, width: number): string[] {
  return list.slice(offset, offset + height).map((e, i) => {
    const index = offset + i;
    const digit = index < 9 ? String(index + 1) : " ";
    const text = fit(`${digit} ${e.glyph} ${e.label}`, width);
    return index === current ? inverse(text) : text;
  });
}

/** The entry index shown on screen row `row`, if any. */
export function entryAt(row: number, offset: number, count: number): number | undefined {
  const index = offset + row;
  return row >= 0 && index < count ? index : undefined;
}

/**
 * Which tab an input asks for, as an entry index; undefined for none or for the current one.
 * Up/`k` and down/`j` step (no wrap), a digit jumps, a click picks a row.
 */
export function targetFor(input: Input, current: number, offset: number, count: number): number | undefined {
  let target: number | undefined;
  if (input.kind === "click") target = entryAt(input.row, offset, count);
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
    offset = clampScroll(scrollFor(current, offset, height), list.length, height);
    const rows = sidebarRows(list, current, offset, height, width);
    process.stdout.write(frame(rows, height, width));
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
        const list = entries();
        const current = list.findIndex((e) => e.ws === self);
        const target = targetFor(input, current, offset, list.length);
        if (target !== undefined) switchTab(list[target]!.ws);
      }
    });
    process.stdout.on("resize", draw);
    const timer = setInterval(draw, POLL_MS);
    draw();
  });
}
