import { fail, type Json } from "./util";

/** The coding agent a workspace runs: Claude Code, or Google's Antigravity CLI (`agy`). */
export const AgentKind = { Claude: "claude", Agy: "agy" } as const;

export type AgentKind = (typeof AgentKind)[keyof typeof AgentKind];

export const AGENT_KINDS: readonly AgentKind[] = Object.values(AgentKind);

export const isAgentKind = (v: Json | undefined): v is AgentKind => AGENT_KINDS.some((k) => k === v);

/** `v` as an agent kind, or an error naming the choices. */
export function parseAgentKind(v: string, where: string): AgentKind {
  if (isAgentKind(v)) return v;

  fail(`${where}: unknown agent ${JSON.stringify(v)}; use one of ${AGENT_KINDS.join(", ")}`);
}
