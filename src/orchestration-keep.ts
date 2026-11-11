import { closeSync, mkdirSync, openSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { sidebarWidth } from "./config";
import { orchestrationTabSpec, type TabSpec } from "./layout";
import { defaultMux, type Mux, TabFocus } from "./mux";
import { ORCHESTRATION_TABS, type OrchestrationTab } from "./orchestration";
import { metaDir, selfCommand } from "./paths";

/** A reopen lock older than this belongs to a sidebar that died holding it. */
export const REOPEN_LOCK_STALE_MS = 30_000;
/** How long the lock holder waits for the multiplexer to list the reopened tab before letting go. */
const APPEAR_WAIT_MS = 2_000;
const APPEAR_POLL_MS = 100;

export interface KeepDeps {
  mux?: Mux;
  sleep?: (ms: number) => void;
  /** The tab to open; defaults to the generated one. */
  spec?: (t: OrchestrationTab) => TabSpec;
}

const orchestrationDir = () => join(metaDir(), "orchestration");
export const reopenLockPath = (tab: string) => join(orchestrationDir(), `${tab}.reopen.lock`);

const isStale = (path: string): boolean => {
  try {
    return Date.now() - statSync(path).mtimeMs > REOPEN_LOCK_STALE_MS;
  } catch {
    // removed between the failed open and the stat: free to take
    return true;
  }
};

/** Take the reopen lock for `tab`, or undefined when another sidebar holds a live one. */
function takeLock(tab: string, retry = true): number | undefined {
  mkdirSync(orchestrationDir(), { recursive: true });
  const path = reopenLockPath(tab);
  try {
    return openSync(path, "wx");
  } catch (e: any) {
    if (e.code !== "EEXIST") {
      throw e;
    }
    if (!retry || !isStale(path)) {
      return undefined;
    }
    rmSync(path, { force: true });
    return takeLock(tab, false);
  }
}

function waitForTab(tab: string, mux: Mux, sleep: (ms: number) => void) {
  for (let waitedMs = 0; waitedMs < APPEAR_WAIT_MS && !mux.tabs().includes(tab); waitedMs += APPEAR_POLL_MS) {
    sleep(APPEAR_POLL_MS);
  }
}

/** Open `t` as a new tab at `index`, then focus the tab the user was on. Returns whether the multiplexer opened it. */
function reopen(t: OrchestrationTab, index: number, mux: Mux, spec: (t: OrchestrationTab) => TabSpec): boolean {
  const focused = mux.currentTab();
  if (!mux.openTab(spec(t), TabFocus.Foreground).ok) {
    return false;
  }
  // a new tab is appended and focused, so walk it to its slot at the front
  mux.moveTab(t.tab, index);
  if (focused && focused !== t.tab) {
    mux.goToTab(focused);
  }
  return true;
}

/**
 * Reopen any orchestration tab missing from the running session; returns the tabs it reopened.
 * Every sidebar calls this on its poll, so a per-tab lock picks one owner. The owner checks again under
 * the lock and holds it until the multiplexer lists the new tab, so a second sidebar never opens a copy. `tabs` is
 * the tab list the caller already queried; empty (outside a session, or the query failed) does nothing.
 */
export function ensureOrchestrationTabs(tabs: string[], deps: KeepDeps = {}): string[] {
  const mux = deps.mux ?? defaultMux();
  const sleep = deps.sleep ?? ((ms) => Bun.sleepSync(ms));
  const spec = deps.spec ?? ((t) => orchestrationTabSpec(t, selfCommand(), { sidebarWidth: sidebarWidth(), focus: true }));
  if (!tabs.length) {
    return [];
  }
  return ORCHESTRATION_TABS.flatMap((t, index) => {
    if (tabs.includes(t.tab)) {
      return [];
    }
    const fd = takeLock(t.tab);
    if (fd === undefined) {
      return [];
    }
    try {
      const now = mux.tabs();
      if (!now.length || now.includes(t.tab) || !reopen(t, index, mux, spec)) {
        return [];
      }
      waitForTab(t.tab, mux, sleep);
      return [t.tab];
    } finally {
      closeSync(fd);
      rmSync(reopenLockPath(t.tab), { force: true });
    }
  });
}

/** An orchestration Claude that exits sooner than this counts as a quick exit. */
export const QUICK_EXIT_MS = 5_000;
const QUICK_EXITS_BEFORE_BACKOFF = 3;
const MAX_BACKOFF_MS = 30_000;

/**
 * After an orchestration tab's Claude exits having run `elapsedMs`, following `streak` quick exits in a
 * row: the new streak and how long to wait before starting a fresh session. A crashing `claude` backs off
 * (1s, 2s, 4s, up to 30s) instead of spinning.
 */
export function restartAfter(elapsedMs: number, streak: number): { streak: number; delayMs: number } {
  const next = elapsedMs < QUICK_EXIT_MS ? streak + 1 : 0;
  if (next < QUICK_EXITS_BEFORE_BACKOFF) {
    return { streak: next, delayMs: 0 };
  }
  return { streak: next, delayMs: Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (next - QUICK_EXITS_BEFORE_BACKOFF)) };
}

/** Signals that mean the tab or the session went away, so the loop stops instead of restarting. */
export const STOP_SIGNALS: ReadonlySet<string> = new Set(["SIGHUP", "SIGTERM", "SIGKILL"]);
