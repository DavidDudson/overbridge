import { mkdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentState, agentStatePath } from "./agent-state";
import { envVar, root, selfCommand, silenceLegacyWarnings } from "./paths";

/**
 * Claude Code hook that records what a workspace's agent is doing, for the sidebar glyphs.
 * Registered in every workspace's .claude/settings.json for several events and run on every
 * tool call, so it imports almost nothing, never loads the CLI, and never blocks or fails.
 */

/** Hook event → state. Events not listed leave the state alone. */
export const EVENT_STATE: Record<string, AgentState> = {
  SessionStart: "idle",
  UserPromptSubmit: "busy",
  PostToolUse: "busy",
  Notification: "waiting",
  Stop: "done",
  SessionEnd: "end",
};

/** An unchanged state is not rewritten more often than this. */
const REWRITE_MS = 2_000;
/** The title/PR cache is refreshed when older than this. */
export const REFRESH_AFTER_MS = 60_000;
/** A second refresh is not started within this window of the last start. */
const REFRESH_LOCK_MS = 30_000;

const ageMs = (path: string, now: number): number => {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return Infinity;
  }
};

/** Record `state` for `ws` unless it is the same state written moments ago. */
export function recordState(metaDir: string, ws: string, state: AgentState, now = Date.now()) {
  const file = agentStatePath(metaDir, ws);
  try {
    const old = JSON.parse(readFileSync(file, "utf8")) as { state?: string; at?: number };
    if (old.state === state && now - (old.at ?? 0) < REWRITE_MS) return;
  } catch {
    // none yet, or unreadable: write it
  }
  mkdirSync(join(metaDir, "agent"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ state, at: now }));
  renameSync(tmp, file);
}

/**
 * True when the top-panel cache for `ws` is stale and nobody started a refresh recently.
 * Claims the refresh by touching a lock file, so concurrent hooks start one.
 */
export function claimRefresh(metaDir: string, ws: string, now = Date.now()): boolean {
  const dir = join(metaDir, "top");
  if (ageMs(join(dir, `${ws}.json`), now) < REFRESH_AFTER_MS) return false;
  const lock = join(dir, `${ws}.refresh`);
  if (ageMs(lock, now) < REFRESH_LOCK_MS) return false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(lock, "");
  utimesSync(lock, now / 1000, now / 1000);
  return true;
}

function startRefresh(ws: string) {
  const [cmd, ...args] = selfCommand();
  Bun.spawn({ cmd: [cmd!, ...args, "top", "refresh", "--ws", ws], stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
}

/** Entry point for `overbridge hook`: the hook payload is JSON on stdin. Always exits 0. */
export async function hookMain(): Promise<number> {
  try {
    silenceLegacyWarnings();
    const ws = envVar("NAME");
    if (!ws) return 0;
    const input = JSON.parse(await Bun.stdin.text()) as { hook_event_name?: string };
    const meta = join(root(), ".overbridge");
    const state = EVENT_STATE[input.hook_event_name ?? ""];
    if (state) recordState(meta, ws, state);
    if (claimRefresh(meta, ws)) startRefresh(ws);
  } catch {
    // a status hook must never get in the way of the agent
  }
  return 0;
}
