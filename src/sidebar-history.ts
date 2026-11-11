import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultMux } from "./mux";
import { metaDir } from "./paths";

/** Which way ← and → walk through the tabs visited from the sidebar. */
export const Travel = { Back: "back", Forward: "forward" } as const;
export type Travel = (typeof Travel)[keyof typeof Travel];

/** The tabs visited from the sidebar, like a browser's: `back` ends with the most recent. */
export interface History {
  back: string[];
  forward: string[];
}

export const EMPTY_HISTORY: History = { back: [], forward: [] };
export const HISTORY_LIMIT = 50;

/** Leaving `leaving` for a tab picked any way but ← and →, which drops the forward list. */
export const visit = (history: History, leaving: string): History => ({
  back: [...history.back, leaving].slice(-HISTORY_LIMIT),
  forward: [],
});

/**
 * ← or → from `here`: the nearest tab in that direction that is still `open` and not `here`, and the history after
 * moving to it. Closed tabs passed over are dropped. No target when none is left, with the history unchanged.
 */
export function travel(history: History, way: Travel, here: string, open: ReadonlySet<string>): { history: History; target?: string } {
  const from = way === Travel.Back ? history.back : history.forward;
  const to = way === Travel.Back ? history.forward : history.back;
  const index = from.findLastIndex((tab) => tab !== here && open.has(tab));
  if (index < 0) {
    return { history };
  }
  const rest = from.slice(0, index);
  const other = [...to, here].slice(-HISTORY_LIMIT);
  return {
    history: way === Travel.Back ? { back: rest, forward: other } : { back: other, forward: rest },
    target: from[index]!,
  };
}

/** The current multiplexer session's name, so two sessions never share a history. */
export const sessionName = () => defaultMux().sessionName();

const historyFile = (session: string) => join(metaDir(), "sidebar-history", `${encodeURIComponent(session)}.json`);

const isTabList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === "string");

/** The session's history; empty when there is none or the file is not a valid one. */
export function readHistory(session = sessionName()): History {
  try {
    const parsed: unknown = JSON.parse(readFileSync(historyFile(session), "utf8"));
    const { back, forward } = (parsed ?? {}) as Partial<Record<keyof History, unknown>>;
    return isTabList(back) && isTabList(forward) ? { back, forward } : EMPTY_HISTORY;
  } catch {
    return EMPTY_HISTORY;
  }
}

/** Save the session's history by rename, so another tab's sidebar never reads half a file. */
export function writeHistory(history: History, session = sessionName()) {
  const file = historyFile(session);
  mkdirSync(join(metaDir(), "sidebar-history"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(history));
  renameSync(tmp, file);
}

/**
 * Save `after`, then `move`. The next tab's sidebar may take a key the moment it has focus, so the history is
 * saved first; when `move` fails the history goes back to `before`.
 */
export function moveWithHistory(before: History, after: History, move: () => boolean, session = sessionName()): boolean {
  writeHistory(after, session);
  const moved = move();
  if (!moved) {
    writeHistory(before, session);
  }
  return moved;
}
