import { closeSync, mkdirSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sidebarWidth } from "./config";
import { newOrchestrationTabKdl } from "./layout";
import { ORCHESTRATION_TABS, type OrchestrationTab } from "./orchestration";
import { metaDir, selfCommand } from "./paths";
import { run } from "./util";

/** A reopen lock older than this belongs to a sidebar that died holding it. */
export const REOPEN_LOCK_STALE_MS = 30_000;
/** How long the lock holder waits for zellij to list the reopened tab before letting go. */
const APPEAR_WAIT_MS = 2_000;
const APPEAR_POLL_MS = 100;

type Exec = (cmd: string[]) => { ok: boolean; stdout: string };

export interface KeepDeps {
  exec?: Exec;
  sleep?: (ms: number) => void;
  /** The tab's layout file content; defaults to the generated one. */
  kdl?: (t: OrchestrationTab) => string;
}

const orchestrationDir = () => join(metaDir(), "orchestration");
export const reopenLockPath = (tab: string) => join(orchestrationDir(), `${tab}.reopen.lock`);

const queryTabs = (exec: Exec): string[] => {
  const r = exec(["zellij", "action", "query-tab-names"]);
  return r.ok ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
};

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

function waitForTab(tab: string, exec: Exec, sleep: (ms: number) => void) {
  for (let waitedMs = 0; waitedMs < APPEAR_WAIT_MS && !queryTabs(exec).includes(tab); waitedMs += APPEAR_POLL_MS) {
    sleep(APPEAR_POLL_MS);
  }
}

/** Open `t` as a new tab at `index`, then focus the tab the user was on. Returns whether zellij opened it. */
function reopen(t: OrchestrationTab, index: number, tabCount: number, exec: Exec, kdl: (t: OrchestrationTab) => string): boolean {
  const focused = /^name: (.+)$/m.exec(exec(["zellij", "action", "current-tab-info"]).stdout)?.[1]?.trim();
  const file = join(orchestrationDir(), `${t.tab}.kdl`);
  writeFileSync(file, kdl(t));
  if (!exec(["zellij", "action", "new-tab", "--layout", file, "--name", t.tab]).ok) {
    return false;
  }
  // new-tab appends the tab and focuses it, so walk it left to its slot at the front
  Array.from({ length: Math.max(0, tabCount - index) }).forEach(() => exec(["zellij", "action", "move-tab", "left"]));
  if (focused && focused !== t.tab) {
    exec(["zellij", "action", "go-to-tab-name", focused]);
  }
  return true;
}

/**
 * Reopen any orchestration tab missing from the running zellij session; returns the tabs it reopened.
 * Every sidebar calls this on its poll, so a per-tab lock picks one owner. The owner checks again under
 * the lock and holds it until zellij lists the new tab, so a second sidebar never opens a copy. `tabs` is
 * the tab list the caller already queried; empty (outside zellij, or the query failed) does nothing.
 */
export function ensureOrchestrationTabs(tabs: string[], deps: KeepDeps = {}): string[] {
  const exec = deps.exec ?? ((cmd) => run(cmd));
  const sleep = deps.sleep ?? ((ms) => Bun.sleepSync(ms));
  const kdl = deps.kdl ?? ((t) => newOrchestrationTabKdl(t, selfCommand(), { sidebarWidth: sidebarWidth() }));
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
      const now = queryTabs(exec);
      if (!now.length || now.includes(t.tab) || !reopen(t, index, now.length, exec, kdl)) {
        return [];
      }
      waitForTab(t.tab, exec, sleep);
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
