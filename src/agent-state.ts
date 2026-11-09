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
 * stale one means the agent died mid-turn; any state is dropped after a day.
 */
export const STALE_MS: Record<AgentState, number> = {
  empty: 24 * 3600_000,
  idle: 24 * 3600_000,
  busy: 10 * 60_000,
  done: 24 * 3600_000,
  bg: 24 * 3600_000,
  waiting: 24 * 3600_000,
  end: 24 * 3600_000,
};

/** `<meta>/agent/<ws>.json`, written by the agent hook as `{"state": "...", "at": <ms>, "bg": [pid...]}`. */
export const agentStatePath = (meta: string, ws: string) => join(meta, "agent", `${ws}.json`);
export const agentStateFile = (ws: string) => agentStatePath(metaDir(), ws);

export { pidAlive };

/**
 * The state of `ws`, or undefined when there is none, it is stale, or the file is unreadable.
 * `done` reads as `bg` while a background shell recorded with it is alive.
 */
export function readAgentState(ws: string, now = Date.now(), alive: (pid: number) => boolean = pidAlive): AgentState | undefined {
  try {
    const { state, at, bg } = JSON.parse(readFileSync(agentStateFile(ws), "utf8")) as { state?: string; at?: number; bg?: unknown };
    const known = AGENT_STATES.find((s) => s === state);
    if (!known) return undefined;
    if (typeof at === "number" && now - at > STALE_MS[known]) return undefined;
    if (known === "done" && Array.isArray(bg) && bg.some((p) => typeof p === "number" && alive(p))) return "bg";
    return known;
  } catch {
    return undefined;
  }
}

export const glyphFor = (state: AgentState | undefined): string => (state ? GLYPHS[state] : UNKNOWN_GLYPH);
