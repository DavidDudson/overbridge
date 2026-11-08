import { readFileSync } from "node:fs";
import { join } from "node:path";
import { metaDir } from "./paths";

/** What a workspace's agent is doing, as the agent hook records it. */
export const AGENT_STATES = ["idle", "busy", "done", "waiting", "end"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Shown when no state has been recorded, or it has gone stale. */
export const UNKNOWN_GLYPH = "·";

export const GLYPHS: Record<AgentState, string> = {
  idle: "○",
  busy: "●",
  done: "✔",
  waiting: "?",
  end: "✖",
};

/**
 * A recorded state older than this is dropped. `busy` is refreshed by every tool call, so a
 * stale one means the agent died mid-turn; any state is dropped after a day.
 */
export const STALE_MS: Record<AgentState, number> = {
  idle: 24 * 3600_000,
  busy: 10 * 60_000,
  done: 24 * 3600_000,
  waiting: 24 * 3600_000,
  end: 24 * 3600_000,
};

/** `<meta>/agent/<ws>.json`, written by the agent hook as `{"state": "...", "at": <ms>}`. */
export const agentStatePath = (meta: string, ws: string) => join(meta, "agent", `${ws}.json`);
export const agentStateFile = (ws: string) => agentStatePath(metaDir(), ws);

/** The recorded state of `ws`, or undefined when there is none, it is stale, or the file is unreadable. */
export function readAgentState(ws: string, now = Date.now()): AgentState | undefined {
  try {
    const { state, at } = JSON.parse(readFileSync(agentStateFile(ws), "utf8")) as { state?: string; at?: number };
    const known = AGENT_STATES.find((s) => s === state);
    if (!known) return undefined;
    return typeof at === "number" && now - at > STALE_MS[known] ? undefined : known;
  } catch {
    return undefined;
  }
}

export const glyphFor = (state: AgentState | undefined): string => (state ? GLYPHS[state] : UNKNOWN_GLYPH);
