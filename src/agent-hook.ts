import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentState, agentStatePath, readAgentState } from "./agent-state";
import { backgroundShells } from "./bg-tasks";
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

/**
 * The state a hook event records, given the session's current state. A session just started or cleared is
 * `empty`, and Claude's later idle notification must not turn that into `waiting`: nobody is being waited on.
 */
export function nextState(event: string, source: string | undefined, current: AgentState | undefined): AgentState | undefined {
  if (event === "SessionStart") return source === "resume" || source === "compact" ? "idle" : "empty";
  if (event === "Notification" && current === "empty") return undefined;
  return EVENT_STATE[event];
}

/** Told to a session that stopped right after an automatic compaction. */
export const COMPACT_RESTART_REASON =
  "Context was auto-compacted. Continue the task you were working on from where you left off; do not start over or wait for the user.";

/** A compaction marker older than this is ignored: the agent stopped for some other reason. */
export const COMPACT_MARKER_MS = 15 * 60_000;

const compactMarker = (metaDir: string, ws: string) => join(metaDir, "agent", `${ws}.compact`);

/** Note that `ws` just auto-compacted. */
export function markCompact(metaDir: string, ws: string, now = Date.now()) {
  mkdirSync(join(metaDir, "agent"), { recursive: true });
  writeFileSync(compactMarker(metaDir, ws), String(now));
}

/** Forget a compaction marker: the agent carried on by itself. */
export const clearCompact = (metaDir: string, ws: string) => rmSync(compactMarker(metaDir, ws), { force: true });

/**
 * Whether the agent has stopped straight after an automatic compaction, without doing anything since.
 * Consumes the marker, so a session is restarted once per compaction and cannot loop.
 */
export function takeCompactRestart(metaDir: string, ws: string, now = Date.now()): boolean {
  let at: number;
  try {
    at = Number(readFileSync(compactMarker(metaDir, ws), "utf8"));
  } catch {
    return false;
  }
  clearCompact(metaDir, ws);
  return now - at < COMPACT_MARKER_MS;
}

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
export function recordState(metaDir: string, ws: string, state: AgentState, now = Date.now(), bg: number[] = []) {
  const file = agentStatePath(metaDir, ws);
  try {
    const old = JSON.parse(readFileSync(file, "utf8")) as { state?: string; at?: number };
    if (old.state === state && bg.length === 0 && !(old as { bg?: unknown[] }).bg?.length && now - (old.at ?? 0) < REWRITE_MS) return;
  } catch {
    // none yet, or unreadable: write it
  }
  mkdirSync(join(metaDir, "agent"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ state, at: now, ...(bg.length ? { bg } : {}) }));
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
  Bun.spawn({ cmd: [cmd!, ...args, "top", "refresh", "--ws", ws], cwd: homedir(), stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }).unref();
}

/** Entry point for `overbridge hook`: the hook payload is JSON on stdin. Always exits 0. */
export async function hookMain(): Promise<number> {
  try {
    silenceLegacyWarnings();
    const ws = envVar("NAME");
    if (!ws) return 0;
    const input = JSON.parse(await Bun.stdin.text()) as { hook_event_name?: string; source?: string; trigger?: string; stop_hook_active?: boolean };
    const meta = join(root(), ".overbridge");
    const event = input.hook_event_name ?? "";
    if (event === "PreCompact" && input.trigger === "auto") markCompact(meta, ws);
    else if (event === "UserPromptSubmit" || event === "PostToolUse") clearCompact(meta, ws);
    else if (event === "Stop" && !input.stop_hook_active && takeCompactRestart(meta, ws)) {
      // stopped right after an auto-compact: block the stop so the agent carries on
      recordState(meta, ws, "busy");
      console.log(JSON.stringify({ decision: "block", reason: COMPACT_RESTART_REASON }));
      return 0;
    }
    const state = nextState(event, input.source, event === "Notification" ? readAgentState(ws) : undefined);
    if (state) recordState(meta, ws, state, Date.now(), state === "done" ? backgroundShells() : []);
    if (claimRefresh(meta, ws)) startRefresh(ws);
  } catch {
    // a status hook must never get in the way of the agent
  }
  return 0;
}
