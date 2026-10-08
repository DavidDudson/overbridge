import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { metaDir } from "./paths";
import { type Cover, overlaps } from "./stack";
import { fail } from "./util";

export type Claim = { branch?: string; pr?: number };
export type WorkspaceState = { created: string; repos: Record<string, Claim> };
export type State = { version: 1; workspaces: Record<string, WorkspaceState> };

const statePath = () => join(metaDir(), "state.json");
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
