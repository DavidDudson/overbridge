import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Agent states with no turn in progress: removing the workspace cannot cut off work. */
export const AT_REST: ReadonlySet<AgentState | undefined> = new Set<AgentState | undefined>([undefined, "empty", "idle", "done", "end"]);

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

/** `<meta>/agent/<ws>.json`, written by the agent hook as `{"state": "...", "at": <ms>, "since": <ms>, "bg": [pid...], "reason": "...", "tool": "..."}`. */
export const agentStatePath = (meta: string, ws: string) => join(meta, "agent", `${ws}.json`);
export const agentStateFile = (ws: string) => agentStatePath(metaDir(), ws);

export { pidAlive };

/** A subagent marker older than this is a leak (its Stop never came) and no longer counts as running. */
export const SUBAGENT_MAX_MS = 6 * 3600_000;

/** `<meta>/agent/<ws>.sub/`: one empty file per running subagent, written by the SubagentStart/Stop hooks. */
export const subagentDir = (meta: string, ws: string) => join(meta, "agent", `${ws}.sub`);

const markerName = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100) || "_";

/** Note that subagent `id` started running for `ws`. */
export function markSubagent(meta: string, ws: string, id: string) {
  mkdirSync(subagentDir(meta, ws), { recursive: true });
  writeFileSync(join(subagentDir(meta, ws), markerName(id)), "");
}

/** Note that subagent `id` finished. */
export const clearSubagent = (meta: string, ws: string, id: string) => rmSync(join(subagentDir(meta, ws), markerName(id)), { force: true });

/** Forget every subagent of `ws` (a session started or ended). */
export const clearSubagents = (meta: string, ws: string) => rmSync(subagentDir(meta, ws), { recursive: true, force: true });

/** How many subagents of `ws` are running, ignoring leaked markers. */
export function runningSubagents(meta: string, ws: string, now = Date.now()): number {
  const dir = subagentDir(meta, ws);
  try {
    return readdirSync(dir).filter((f) => {
      try {
        return now - statSync(join(dir, f)).mtimeMs < SUBAGENT_MAX_MS;
      } catch {
        return false; // its SubagentStop removed it while we listed
      }
    }).length;
  } catch {
    return 0;
  }
}

/** A tool name safe to draw in a terminal: no control characters, bounded. */
export const TOOL_NAME = /^[\w.:-]{1,64}$/;

export interface AgentRecord {
  state: AgentState;
  /** The SessionEnd reason, recorded with `end` only. */
  reason?: string;
  /** When the state began (ms): the hook keeps it while the same state is rewritten. Older records fall back to `at`. */
  since?: number;
  /** The tool a `waiting` state is blocked on. */
  tool?: string;
  /** Running subagents plus live background shells. */
  agents: number;
}


function readAgentRecord(ws: string, now: number, alive: (pid: number) => boolean): AgentRecord | undefined {
  try {
    const { state, at, bg, reason, since, tool } = JSON.parse(readFileSync(agentStateFile(ws), "utf8")) as { state?: string; at?: number; bg?: unknown; reason?: unknown; since?: unknown; tool?: unknown };
    const known = AGENT_STATES.find((s) => s === state);
    if (!known) {
      return undefined;
    }
    const subagents = runningSubagents(metaDir(), ws, now);
    const hasSubagents = subagents > 0;
    const liveBg = Array.isArray(bg) ? bg.filter((p) => typeof p === "number" && alive(p)).length : 0;
    const began = typeof since === "number" ? since : typeof at === "number" ? at : undefined;
    const detail = {
      agents: subagents + liveBg,
      ...(began === undefined ? {} : { since: began }),
      ...(typeof tool === "string" && known === "waiting" && TOOL_NAME.test(tool) ? { tool } : {}),
    };
    // a subagent can run for longer than a turn goes without a tool call, so it keeps `busy` alive
    if (typeof at === "number" && now - at > STALE_MS[known] && !(known === "busy" && hasSubagents)) {
      return undefined;
    }
    if (known === "done" && (hasSubagents || liveBg > 0)) {
      return { state: "bg", ...detail };
    }
    return typeof reason === "string" ? { state: known, reason, ...detail } : { state: known, ...detail };
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

/** `readAgentState` plus the rest of the record, from the same single file read. */
export const readAgentDetail = (ws: string, now = Date.now(), alive: (pid: number) => boolean = pidAlive): AgentRecord | undefined => readAgentRecord(ws, now, alive);

/** Whether `ws`'s session ended and the user closed it on purpose (`endedForGood`). */
export function sessionEndedForGood(ws: string, now = Date.now()): boolean {
  const record = readAgentRecord(ws, now, pidAlive);
  return record?.state === "end" && endedForGood(record.reason);
}

export const glyphFor = (state: AgentState | undefined): string => (state ? GLYPHS[state] : UNKNOWN_GLYPH);

/** When the agent hook last recorded anything for `ws` (ms), however old; undefined when there is no record. */
export function readAgentAt(ws: string): number | undefined {
  try {
    const { at } = JSON.parse(readFileSync(agentStateFile(ws), "utf8")) as { at?: unknown };
    return typeof at === "number" && Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * `<meta>/agent/<ws>.turn.json`: the last turn's receipt, kept by the hook so the sidebar never scans history.
 * `startedAt` is the last prompt, `endedAt` its Stop; `compactedAt` the last compaction.
 */
export interface TurnSummary {
  startedAt?: number;
  endedAt?: number;
  edits?: number;
  errors?: number;
  compactedAt?: number;
}

export const turnPath = (meta: string, ws: string) => join(meta, "agent", `${ws}.turn.json`);

/** Tools whose successful call counts as an edit. */
export const EDIT_TOOLS: readonly string[] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** What `event` does to the turn summary: undefined for the many events (most tool calls) that leave it alone, so they cost no I/O. */
export function turnChange(event: string, tool: string | undefined, source: string | undefined, now: number): ((t: TurnSummary) => TurnSummary) | "reset" | undefined {
  switch (event) {
    case "SessionStart":
      return source === "resume" || source === "compact" ? undefined : "reset";
    case "UserPromptSubmit":
      return (t) => ({ ...(t.compactedAt === undefined ? {} : { compactedAt: t.compactedAt }), startedAt: now, edits: 0, errors: 0 });
    case "PostToolUse":
      return tool !== undefined && EDIT_TOOLS.includes(tool) ? (t) => ({ ...t, edits: (t.edits ?? 0) + 1 }) : undefined;
    case "PostToolUseFailure":
      return (t) => ({ ...t, errors: (t.errors ?? 0) + 1 });
    case "Stop":
      return (t) => ({ ...t, endedAt: now });
    case "PreCompact":
      return (t) => ({ ...t, compactedAt: now });
    default:
      return undefined;
  }
}

/** Apply `event` to `ws`'s turn summary. Best effort: a parallel hook may lose a count. */
export function recordTurn(meta: string, ws: string, event: string, tool: string | undefined, source: string | undefined, now = Date.now()) {
  const change = turnChange(event, tool, source, now);
  if (!change) return;
  const file = turnPath(meta, ws);
  if (change === "reset") return rmSync(file, { force: true });
  let old: TurnSummary = {};
  try {
    old = JSON.parse(readFileSync(file, "utf8")) as TurnSummary;
  } catch {
    // none yet
  }
  mkdirSync(join(meta, "agent"), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(change(old)));
  renameSync(tmp, file);
}
