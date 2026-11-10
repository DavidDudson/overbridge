import { readFileSync } from "node:fs";
import { join } from "node:path";
import { metaDir } from "./paths";
import { pidAlive } from "./proc";

/**
 * What a workspace's agent is doing. `empty` is a session just started or cleared: no conversation to lose. `bg` is never recorded: it is `done` read while background
 * tasks recorded at the end of the turn are still running.
 */
export const AGENT_STATES = ["empty", "idle", "busy", "done", "bg", "waiting", "end"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Why a Claude session ended: the `reason` of Claude's SessionEnd hook. */
export const EndReason = {
  Clear: "clear",
  Resume: "resume",
  Logout: "logout",
  PromptInputExit: "prompt_input_exit",
  Other: "other",
} as const;
export type EndReason = (typeof EndReason)[keyof typeof EndReason];

/** End reasons that start another session in the same pane, so the workspace is still in use. */
export const CONTINUING_END_REASONS: readonly string[] = [EndReason.Clear, EndReason.Resume];

/**
 * Whether a session that ended for `reason` was closed on purpose, so its workspace can go. Quitting zellij or
 * rebooting also ends every session (reason `other`), and those workspaces resume when the session is relaunched.
 */
export const endedForGood = (reason: string | undefined): boolean => reason === EndReason.PromptInputExit;

/** Shown when no state has been recorded, or it has gone stale. */
export const UNKNOWN_GLYPH = "·";

export const GLYPHS: Record<AgentState, string> = {
  empty: "🆕",
  idle: "💤",
  busy: "🔄",
  done: "✅",
  bg: "⏳",
  waiting: "❓",
  end: "❌",
};

/** States that want the user, most urgent first: what `overbridge next` cycles through. */
export const ATTENTION: readonly AgentState[] = ["waiting", "done", "bg"];

/**
 * A recorded state older than this is dropped. `busy` is refreshed by every tool call, so a
 * stale one means the agent died mid-turn; most states are dropped after a day. `end` never goes stale: an ended
 * workspace with unsaved work keeps its mark until the work is pushed or thrown away.
 */
export const STALE_MS: Record<AgentState, number> = {
  empty: 24 * 3600_000,
  idle: 24 * 3600_000,
  busy: 10 * 60_000,
  done: 24 * 3600_000,
  bg: 24 * 3600_000,
  waiting: 24 * 3600_000,
  end: Infinity,
};

/** `<meta>/agent/<ws>.json`, written by the agent hook as `{"state": "...", "at": <ms>, "bg": [pid...], "reason": "..."}`. */
export const agentStatePath = (meta: string, ws: string) => join(meta, "agent", `${ws}.json`);
export const agentStateFile = (ws: string) => agentStatePath(metaDir(), ws);

export { pidAlive };

interface AgentRecord {
  state: AgentState;
  /** The SessionEnd reason, recorded with `end` only. */
  reason?: string;
}

function readAgentRecord(ws: string, now: number, alive: (pid: number) => boolean): AgentRecord | undefined {
  try {
    const { state, at, bg, reason } = JSON.parse(readFileSync(agentStateFile(ws), "utf8")) as { state?: string; at?: number; bg?: unknown; reason?: unknown };
    const known = AGENT_STATES.find((s) => s === state);
    if (!known) {
      return undefined;
    }
    if (typeof at === "number" && now - at > STALE_MS[known]) {
      return undefined;
    }
    if (known === "done" && Array.isArray(bg) && bg.some((p) => typeof p === "number" && alive(p))) {
      return { state: "bg" };
    }
    return typeof reason === "string" ? { state: known, reason } : { state: known };
  } catch {
    return undefined;
  }
}

/**
 * The state of `ws`, or undefined when there is none, it is stale, or the file is unreadable.
 * `done` reads as `bg` while a background shell recorded with it is alive.
 */
export const readAgentState = (ws: string, now = Date.now(), alive: (pid: number) => boolean = pidAlive): AgentState | undefined =>
  readAgentRecord(ws, now, alive)?.state;

/** Whether `ws`'s session ended and the user closed it on purpose (`endedForGood`). */
export function sessionEndedForGood(ws: string, now = Date.now()): boolean {
  const record = readAgentRecord(ws, now, pidAlive);
  return record?.state === "end" && endedForGood(record.reason);
}

export const glyphFor = (state: AgentState | undefined): string => (state ? GLYPHS[state] : UNKNOWN_GLYPH);
