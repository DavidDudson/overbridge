import { mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { metaDir } from "./paths";
import { currentTab, tabOrder, type ZellijExec, zellijQuery } from "./tab";

/**
 * One shared copy of zellij's tab order and focused tab, so every sidebar and top panel reads a file
 * instead of starting its own zellij client each poll. One reader per `VIEW_MAX_AGE_MS` refreshes it.
 */

/** How old the shared view may be before a reader refreshes it. */
export const VIEW_MAX_AGE_MS = 1_000;
/** How often a pane on a hidden tab still gathers and draws, so it is close to current when shown. */
export const HIDDEN_POLL_MS = 30_000;

export interface ZellijView {
  order: string[];
  /** Undefined when zellij could not say, such as outside a session. */
  focused?: string;
  atMs: number;
}

export interface ViewDeps {
  dir?: string;
  nowMs?: number;
  exec?: ZellijExec;
}

const EMPTY_VIEW: ZellijView = { order: [], atMs: 0 };

export const viewPath = (dir: string) => join(dir, "zellij-view.json");
const lockPath = (dir: string) => join(dir, "zellij-view.lock");

const ageMs = (path: string, nowMs: number): number => {
  try {
    return nowMs - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
};

const isView = (v: unknown): v is ZellijView => {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const r = v as Record<string, unknown>;
  return Array.isArray(r.order) && r.order.every((t) => typeof t === "string") && typeof r.atMs === "number" && (r.focused === undefined || typeof r.focused === "string");
};

function readCached(dir: string): ZellijView | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(viewPath(dir), "utf8"));
    return isView(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** True when this caller should refresh the view; touches the lock so the other panes skip this round. */
function claimViewRefresh(dir: string, nowMs: number): boolean {
  const lock = lockPath(dir);
  if (ageMs(lock, nowMs) < VIEW_MAX_AGE_MS) {
    return false;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(lock, "");
  utimesSync(lock, nowMs / 1000, nowMs / 1000);
  return true;
}

function writeView(dir: string, view: ZellijView) {
  const file = viewPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(view));
  renameSync(tmp, file);
}

/** The shared view, refreshed from zellij when stale and no other pane is refreshing it. Never throws. */
export function readView(deps: ViewDeps = {}): ZellijView {
  const nowMs = deps.nowMs ?? Date.now();
  try {
    const dir = deps.dir ?? metaDir();
    const cached = readCached(dir);
    if (cached && nowMs - cached.atMs < VIEW_MAX_AGE_MS) {
      return cached;
    }
    if (!claimViewRefresh(dir, nowMs)) {
      return cached ?? EMPTY_VIEW;
    }
    const exec = deps.exec ?? zellijQuery;
    const focused = currentTab(exec);
    const view: ZellijView = { order: tabOrder(exec), ...(focused === undefined ? {} : { focused }), atMs: nowMs };
    writeView(dir, view);
    return view;
  } catch {
    return EMPTY_VIEW;
  }
}

/** True when `tab` is the focused tab, or when zellij could not say, so a pane never goes quiet by mistake. */
export const isFocused = (tab: string, view: ZellijView): boolean => view.focused === undefined || view.focused === tab;

/** Whether a poll tick should do its full work: always on the focused tab, every `HIDDEN_POLL_MS` on a hidden one. */
export const shouldPoll = (tab: string, view: ZellijView, lastPollAtMs: number, nowMs: number): boolean =>
  isFocused(tab, view) || nowMs - lastPollAtMs >= HIDDEN_POLL_MS;

/** A writer that skips a frame identical to the last one written. `invalidate` forces the next write. */
export function createPainter(write: (text: string) => void) {
  let lastPainted: string | undefined;
  return {
    paint(text: string) {
      if (text === lastPainted) {
        return;
      }
      lastPainted = text;
      write(text);
    },
    invalidate() {
      lastPainted = undefined;
    },
  };
}
