import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { AppStatus, stopApp } from "./apps";
import { removeWorkspace } from "./commands";
import { landingTab } from "./next";
import { isOrchestrationTab, orchestrationRemoveMessage } from "./orchestration";
import { metaDir, root, selfCommand } from "./paths";
import { entries, switchTab, tabOrder } from "./sidebar";
import { openTab } from "./tab";
import { getWorkspace, isRemoving, readState, withState } from "./state";
import { cleanable, gitClean, refreshTop, snapshotTop } from "./top";
import { fail, type RunResult, run } from "./util";

/** The internal `rm` flag that runs `finishRemoval` in the detached worker. */
export const FINISH_FLAG = "background-finish";

/** How long the worker waits for the removed tab to close, so nothing in it still writes to the worktree. */
const TAB_GONE_TIMEOUT_MS = 5_000;

export const removeLogPath = (ws: string) => join(metaDir(), "remove", `${ws}.log`);

export interface RemovalDeps {
  exec: (cmd: string[]) => RunResult;
  /** Start the background worker for `ws`, detached so it outlives this tab; returns its pid. */
  spawnWorker: (ws: string) => number;
  /** Whether this runs inside zellij, so there is a tab to switch away from and close. */
  inZellij: boolean;
}

const defaultDeps = (): RemovalDeps => ({
  exec: (cmd) => run(cmd),
  spawnWorker: spawnFinishWorker,
  inZellij: !!process.env.ZELLIJ,
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

/** Tab name → stable tab id, from `zellij action list-tabs` (`TAB_ID POSITION NAME` rows under a header). */
export function parseTabIds(listTabs: string): Map<string, string> {
  return new Map(
    listTabs
      .split("\n")
      .flatMap((line) => {
        const m = /^\s*(\d+)\s+\d+\s+(.+?)\s*$/.exec(line);
        return m ? [[m[2]!, m[1]!] as const] : [];
      }),
  );
}

/**
 * Remove `ws` without making the user wait: refuse at once when git holds unsaved work, otherwise mark it
 * removing (every sidebar hides it), start the worker that does the slow part, switch to the landing tab
 * and close `ws`'s tab. `previous` is the tab the user came from, when known. Returns a refusal message,
 * or undefined once the removal is under way.
 */
export function beginRemoval(ws: string, opts: { previous?: string; deps?: RemovalDeps } = {}): string | undefined {
  if (isOrchestrationTab(ws)) {
    return orchestrationRemoveMessage(ws);
  }
  const deps = opts.deps ?? defaultDeps();
  const w = getWorkspace(readState(), ws);
  if (isRemoving(w)) {
    return `${ws} is already being removed`;
  }
  if (!gitClean(ws)) {
    return `${ws} has uncommitted changes or unpushed commits; not removing`;
  }
  const list = deps.inZellij ? entries() : [];
  withState((s) => {
    const { removeError: _, ...rest } = getWorkspace(s, ws);
    s.workspaces[ws] = { ...rest, removing: { since: new Date().toISOString() } };
  });
  const pid = deps.spawnWorker(ws);
  withState((s) => {
    const current = s.workspaces[ws];
    if (current?.removing) {
      s.workspaces[ws] = { ...current, removing: { ...current.removing, pid } };
    }
  });
  if (deps.inZellij) {
    leaveTab(ws, landingTab(list, ws, opts.previous), deps.exec);
  }
  return undefined;
}

/** Switch to `landing` first, then close `ws`'s tab by id, so the close never depends on which tab has focus. */
function leaveTab(ws: string, landing: string | undefined, exec: RemovalDeps["exec"]) {
  if (landing !== undefined) {
    switchTab(landing, exec);
  }
  const id = parseTabIds(exec(["zellij", "action", "list-tabs"]).stdout).get(ws);
  if (id !== undefined) {
    exec(["zellij", "action", "close-tab-by-id", id]);
  }
}

function waitTabGone(ws: string) {
  const deadline = Date.now() + TAB_GONE_TIMEOUT_MS;
  while (tabOrder().includes(ws) && Date.now() < deadline) {
    Bun.sleepSync(100);
  }
}

/**
 * The worker's half: re-check from the network that `ws` is still cleanable, stop its apps and run a
 * non-force remove. On any failure the workspace comes back with the error on its sidebar card and its tab reopened.
 */
export async function finishRemoval(ws: string): Promise<void> {
  try {
    if (process.env.ZELLIJ) {
      waitTabGone(ws);
    }
    refreshTop(ws);
    if (!cleanable(ws)) {
      fail(`${ws} is no longer clean (no open PR, or uncommitted or unpushed work); not removed`);
    }
    const { apps } = await snapshotTop(ws);
    apps
      .filter((app) => app.status === AppStatus.Running || app.status === AppStatus.Starting)
      .forEach((app) => stopApp(ws, app.repo, app.spec, app.repoDir));
    removeWorkspace(ws, false);
  } catch (e) {
    restore(ws, (e as Error).message);
    throw e;
  }
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
  if (kept && process.env.ZELLIJ) {
    openTab(ws);
  }
}
