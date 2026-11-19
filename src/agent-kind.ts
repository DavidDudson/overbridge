import type { JsonValue } from "./json";

/** The coding agent a workspace runs: Claude Code, or Google's Antigravity CLI (`agy`). The hook imports this, so it imports nothing. */
export const AgentKind = { Claude: "claude", Agy: "agy" } as const;

export type AgentKind = (typeof AgentKind)[keyof typeof AgentKind];

export const AGENT_KINDS: readonly AgentKind[] = Object.values(AgentKind);

export const isAgentKind = (v: JsonValue | undefined): v is AgentKind => AGENT_KINDS.some((k) => k === v);
