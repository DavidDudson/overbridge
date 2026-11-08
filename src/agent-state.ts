import { readFileSync } from "node:fs";
import { join } from "node:path";
import { metaDir } from "./paths";

/** What a workspace's agent is doing, as the agent hook records it. */
export const AGENT_STATES = ["idle", "busy", "done", "waiting", "end"] as const;
export type AgentState = (typeof AGENT_STATES)[number];

/** Shown when no state has been recorded. */
export const UNKNOWN_GLYPH = "·";

export const GLYPHS: Record<AgentState, string> = {
  idle: "○",
  busy: "●",
  done: "✔",
  waiting: "?",
  end: "✖",
};

/** `<meta>/agent/<ws>.json`, written by the agent hook as `{"state": "...", "at": <ms>}`. */
export const agentStateFile = (ws: string) => join(metaDir(), "agent", `${ws}.json`);

/** The recorded state of `ws`, or undefined when there is none or the file is unreadable. */
export function readAgentState(ws: string): AgentState | undefined {
  try {
    const { state } = JSON.parse(readFileSync(agentStateFile(ws), "utf8")) as { state?: string };
    return AGENT_STATES.find((s) => s === state);
  } catch {
    return undefined;
  }
}

export const glyphFor = (state: AgentState | undefined): string => (state ? GLYPHS[state] : UNKNOWN_GLYPH);
