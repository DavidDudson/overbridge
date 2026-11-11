import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { AppStatus, stopApp } from "./apps";
import { CleanupCause, CleanupOutcome, recordCleanup } from "./cleanup-log";
import { removeWorkspace } from "./commands";
import { landingTab } from "./next";
import { isOrchestrationTab, orchestrationRemoveMessage } from "./orchestration";
import { metaDir, root, selfCommand } from "./paths";
import { defaultMux, type Mux } from "./mux";
import { entries, switchTab } from "./sidebar";
import { openTab } from "./tab";
import { getWorkspace, isRemoving, readState, withState } from "./state";
import { cleanable, noUnsavedWork, readTopCache, refreshTop, sidebarLabel, snapshotTop } from "./top";
import { fail } from "./util";

/** The internal `rm` flag that runs `finishRemoval` in the detached worker. */
export const FINISH_FLAG = "background-finish";

/** How long the worker waits for the removed tab to close, so nothing in it still writes to the worktree. */
const TAB_GONE_TIMEOUT_MS = 5_000;

export const removeLogPath = (ws: string) => join(metaDir(), "remove", `${ws}.log`);

export interface RemovalDeps {
  mux: Mux;
  /** Start the background worker for `ws`, detached so it outlives this tab; returns its pid. */
  spawnWorker: (ws: string) => number;
}

export const defaultDeps = (): RemovalDeps => ({
  mux: defaultMux(),
  spawnWorker: spawnFinishWorker,
});

function spawnFinishWorker(ws: string): number {
  mkdirSync(join(metaDir(), "remove"), { recursive: true });
  const logFd = openSync(removeLogPath(ws), "w");
  try {
    const proc = Bun.spawn({
      cmd: [...selfCommand(), "rm", ws, `--${FINISH_FLAG}`],
      cwd: root(),
      stdin: "ignore",
      stdout: logFd,
      stderr: logFd,
      detached: true,
    });
    proc.unref();
    return proc.pid;
  } finally {
    closeSync(logFd);
  }
}

/**
 * When `beginRemoval` moves the user to another tab. `Always` suits Cleanup, pressed from the workspace's own tab.
 * `IfFocused` suits a removal the user didn't start, which must not pull them off the tab they are on.
 */
export const Landing = { Always: "always", IfFocused: "if-focused" } as const;
export type Landing = (typeof Landing)[keyof typeof Landing];

/**
 * Remove `ws` without making the user wait: refuse at once when git holds unsaved work, otherwise mark it
 * removing (every sidebar hides it), start the worker that does the slow part, switch to the landing tab
 * and close `ws`'s tab. `previous` is the tab the user came from, when known; `cause` is what the cleanup log
 * credits, the Cleanup button unless set. Returns a refusal message,
 * or undefined once the removal is under way.
 */
export function beginRemoval(ws: string, opts: { previous?: string; landing?: Landing; cause?: CleanupCause; deps?: RemovalDeps } = {}): string | undefined {
  if (isOrchestrationTab(ws)) {
    return orchestrationRemoveMessage(ws);
  }
  const deps = opts.deps ?? defaultDeps();
  const alreadyRemoving = `${ws} is already being removed`;
  if (isRemoving(getWorkspace(readState(), ws))) {
    return alreadyRemoving;
  }
  if (!noUnsavedWork(ws)) {
    return `${ws} has uncommitted changes or unpushed commits; not removing`;
  }
  const list = deps.mux.inSession() ? entries() : [];
  // several sidebars can start the same automatic removal at once, so the check and the mark share one lock
  const claimed = withState((s) => {
    const current = getWorkspace(s, ws);
    if (isRemoving(current)) {
      return false;
    }
    const { removeError: _, ...rest } = current;
    s.workspaces[ws] = { ...rest, removing: { since: new Date().toISOString(), cause: opts.cause ?? CleanupCause.Cleanup } };
    return true;
  });
  if (!claimed) {
    return alreadyRemoving;
  }
  const pid = deps.spawnWorker(ws);
  withState((s) => {
    const current = s.workspaces[ws];
    if (current?.removing) {
      s.workspaces[ws] = { ...current, removing: { ...current.removing, pid } };
    }
  });
  if (deps.mux.inSession()) {
    const switchAway = opts.landing !== Landing.IfFocused || deps.mux.currentTab() === ws;
    leaveTab(ws, switchAway ? landingTab(list, ws, opts.previous) : undefined, deps.mux);
  }
  return undefined;
}

/** Switch to `landing` first, then close `ws`'s tab by id, so the close never depends on which tab has focus. */
export function leaveTab(ws: string, landing: string | undefined, mux: Mux) {
  if (landing !== undefined) {
    switchTab(landing, mux);
  }
  mux.closeTab(ws);
}

function waitTabGone(ws: string) {
  const deadline = Date.now() + TAB_GONE_TIMEOUT_MS;
  const mux = defaultMux();
  while (mux.tabs().includes(ws) && Date.now() < deadline) {
    Bun.sleepSync(100);
  }
}

/**
 * The worker's half: re-check from the network that `ws` is still cleanable, stop its apps and run a
 * non-force remove. On any failure the workspace comes back with the error on its sidebar card and its tab reopened.
 * Either way the outcome goes in the cleanup log the sidebar lists.
 */
export async function finishRemoval(ws: string): Promise<void> {
  const label = sidebarLabel(ws, readTopCache(ws));
  const cause = readState().workspaces[ws]?.removing?.cause ?? CleanupCause.Cleanup;
  try {
    if (defaultMux().inSession()) {
      waitTabGone(ws);
    }
    refreshTop(ws);
    if (!cleanable(ws)) {
      fail(`${ws} is no longer clean (no open or merged PRs, or uncommitted or unpushed work); not removed`);
    }
    await stopApps(ws);
    removeWorkspace(ws, false);
    recordCleanup({ ws, label, atMs: Date.now(), outcome: CleanupOutcome.Removed, cause });
  } catch (e) {
    restore(ws, (e as Error).message);
    recordCleanup({ ws, label, atMs: Date.now(), outcome: CleanupOutcome.Failed, cause });
    throw e;
  }
}

/** Stop every app of `ws` that is running or starting. */
export async function stopApps(ws: string): Promise<void> {
  const { apps } = await snapshotTop(ws);
  apps
    .filter((app) => app.status === AppStatus.Running || app.status === AppStatus.Starting)
    .forEach((app) => stopApp(ws, app.repo, app.spec, app.repoDir));
}

function restore(ws: string, error: string) {
  const kept = withState((s) => {
    const w = s.workspaces[ws];
    if (!w) {
      return false;
    }
    const { removing: _, ...rest } = w;
    s.workspaces[ws] = { ...rest, removeError: error };
    return true;
  });
  if (kept && defaultMux().inSession()) {
    openTab(ws);
  }
}
