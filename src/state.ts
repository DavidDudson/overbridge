import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CleanupCause, CleanupRecord } from "./cleanup-log";
import { metaDir } from "./paths";
import { pidAlive } from "./proc";
import { type Cover, overlaps } from "./stack";
import { fail } from "./util";

export type Claim = { branch?: string; pr?: number };
/** A background removal in flight: when it started, what started it and, once spawned, the worker's pid. */
export type Removing = { since: string; cause?: CleanupCause; pid?: number };
/** Why a workspace that would be removed by itself is kept; shown on its sidebar card. */
export const RemovalBlock = { MergedUnsaved: "merged-unsaved" } as const;
export type RemovalBlock = (typeof RemovalBlock)[keyof typeof RemovalBlock];
/** A paused workspace: no tab, no processes, claims and worktrees kept. */
export type Iceboxed = { since: string; handoff?: string };
export type WorkspaceState = {
  created: string;
  repos: Record<string, Claim>;
  /** Set while the background removal worker runs; the sidebar hides the workspace meanwhile. */
  removing?: Removing;
  /** Why the last background removal failed; shown on the workspace's sidebar card. */
  removeError?: string;
  /** Set by the merged-PR sweep when the workspace would be removed but holds unsaved work. */
  removalBlocked?: RemovalBlock;
  /** Set by `overbridge icebox`; cleared by `thaw`. The workspace has no tab while it is set. */
  iceboxed?: Iceboxed;
};
export type State = {
  version: 1;
  workspaces: Record<string, WorkspaceState>;
  /** When a sidebar last took the merged-PR sweep (ms), so only one sidebar runs it per interval. */
  mergeSweepAt?: number;
  /** Finished workspace removals, newest last, for the sidebar to list. */
  cleanups?: CleanupRecord[];
};

const STATE_FILE = "state.json";
const statePath = () => join(metaDir(), STATE_FILE);
const lockPath = () => join(metaDir(), "state.lock");

const LOCK_WAIT_MS = 15_000;
const LOCK_STALE_MS = 60_000;

export function readState(): State {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8"));
  } catch (e: any) {
    if (e.code === "ENOENT") return { version: 1, workspaces: {} };
    throw e;
  }
}

function writeState(s: State) {
  const tmp = `${statePath()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  renameSync(tmp, statePath());
}

/**
 * Read-modify-write state under an exclusive lock. If `fn` throws, nothing is
 * written, so claims are only recorded when the git operation succeeded.
 */
export function withState<T>(fn: (s: State) => T): T {
  mkdirSync(metaDir(), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | undefined;
  while (fd === undefined) {
    try {
      fd = openSync(lockPath(), "wx");
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lockPath()).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath(), { force: true });
          continue;
        }
      } catch {}
      if (Date.now() > deadline) fail(`state is locked (${lockPath()}); delete it if no ws command is running`);
      Bun.sleepSync(50);
    }
  }
  try {
    const s = readState();
    const out = fn(s);
    writeState(s);
    return out;
  } finally {
    closeSync(fd);
    rmSync(lockPath(), { force: true });
  }
}

/**
 * Call `onChange` soon after state is written, so every pane sees a change together instead of on its next poll.
 * `writeState` renames a temp file into place, so this watches the directory, not the file. Returns a stop function.
 */
export function watchState(onChange: () => void, debounceMs = 50): () => void {
  mkdirSync(metaDir(), { recursive: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(metaDir(), (_event, filename) => {
    if (filename !== STATE_FILE) {
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  return () => {
    clearTimeout(timer);
    watcher.close();
  };
}

/** How long a removal mark hides the workspace before its worker has written its pid. */
export const REMOVING_GRACE_MS = 30_000;

/**
 * Whether `w` is being removed in the background right now. A mark whose worker died (no live pid once the
 * grace period is over) no longer counts, so a killed worker never hides a workspace for good.
 */
export function isRemoving(w: WorkspaceState, now = Date.now(), alive: (pid: number) => boolean = pidAlive): boolean {
  if (!w.removing) {
    return false;
  }
  if (w.removing.pid !== undefined) {
    return alive(w.removing.pid);
  }
  return now - Date.parse(w.removing.since) < REMOVING_GRACE_MS;
}

/** Whether `w` is paused by `overbridge icebox`. */
export const isIceboxed = (w: WorkspaceState | undefined): boolean => w?.iceboxed !== undefined;

export function getWorkspace(s: State, ws: string): WorkspaceState {
  return s.workspaces[ws] ?? fail(`no workspace '${ws}'`);
}

/**
 * Another workspace whose claim on `repo` overlaps `want`. `coverOf` widens a
 * claim to everything it holds (worktree head, whole gh-stack stacks).
 */
export function claimOwner(
  s: State,
  repo: string,
  want: Cover,
  coverOf: (ws: string, c: Claim) => Cover,
  self: string,
): string | undefined {
  for (const [ws, w] of Object.entries(s.workspaces)) {
    const c = w.repos[repo];
    if (ws !== self && c && overlaps(coverOf(ws, c), want)) return ws;
  }
}
