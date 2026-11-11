import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { metaDir } from "./paths";

/**
 * What each workspace's agent and checks spent their time on. Events are appended by the agent hook and by
 * `overbridge check`, and read by `overbridge history` and the `@perf` tab. The agent hook runs on every tool
 * call, so this file imports node builtins and `paths.ts` only.
 *
 * `HistoryStore` is the seam for the server the refresh spike proposes: it can provide another implementation and
 * `historyStore()` returns it, with no change to the writers or readers.
 */

/** Claude Code hook events that are recorded. */
export const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"] as const;
export type ClaudeEvent = (typeof CLAUDE_EVENTS)[number];

/** A coarse class for a command, so history never needs to keep a Bash command's text. */
export const COMMAND_CLASSES = ["test", "lint", "build", "typecheck", "format", "git", "other"] as const;
export type CommandClass = (typeof COMMAND_CLASSES)[number];

const CLASS_PATTERNS: readonly [CommandClass, RegExp][] = [
  ["typecheck", /\b(typecheck|tsc|mypy|pyright|type-check)\b/],
  ["lint", /\b(lint|eslint|clippy|ruff|biome|shellcheck|statix)\b/],
  ["format", /\b(fmt|format|prettier|rustfmt|nixfmt|treefmt)\b/],
  ["test", /\b(test|tests|vitest|jest|pytest|spec|e2e)\b/],
  ["build", /\b(build|compile|bundle|nix build|cargo build|webpack|vite)\b/],
  ["git", /^\s*(git|gh)\b/],
];

/** The class of a command line: the first pattern it matches, else `other`. */
export function classifyCommand(command: string): CommandClass {
  return CLASS_PATTERNS.find(([, re]) => re.test(command))?.[0] ?? "other";
}

export interface ClaudeRecord {
  kind: "claude";
  /** Epoch ms. */
  at: number;
  event: ClaudeEvent;
  /** The tool, on `PreToolUse` and `PostToolUse`. */
  tool?: string;
  /** Pairs a `PreToolUse` with its `PostToolUse`. */
  id?: string;
  /** What a Bash call is, never its text. */
  cls?: CommandClass;
}

export interface CheckRecord {
  kind: "check";
  /** Epoch ms when the run ended. */
  at: number;
  repo: string;
  command: string;
  cls: CommandClass;
  /** Time waiting in the check queue. */
  queuedMs: number;
  /** Time the command ran. */
  runMs: number;
  exit: number;
}

export type HistoryRecord = ClaudeRecord | CheckRecord;

export interface HistoryStore {
  append(ws: string, record: HistoryRecord): void;
  /** `ws`'s records at or after `sinceMs`, oldest first. */
  read(ws: string, sinceMs?: number): HistoryRecord[];
  /** Every workspace with history. */
  workspaces(): string[];
}

/** A history file is cut to its newest half once it passes this size. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;

const safeName = (ws: string) => ws.replace(/[^\w@.-]/g, "_");

/** One JSON line per record in `<dir>/<ws>.jsonl`. A line is one `appendFileSync`, so concurrent writers do not interleave. */
export function fileStore(dir: string, maxBytes = MAX_FILE_BYTES): HistoryStore {
  const file = (ws: string) => join(dir, `${safeName(ws)}.jsonl`);
  const parse = (text: string): HistoryRecord[] =>
    text.split("\n").flatMap((line) => {
      if (!line) return [];
      try {
        return [JSON.parse(line) as HistoryRecord];
      } catch {
        return [];
      }
    });
  return {
    append(ws, record) {
      mkdirSync(dir, { recursive: true });
      const path = file(ws);
      appendFileSync(path, JSON.stringify(record) + "\n");
      if (statSync(path).size > maxBytes) {
        const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
        writeFileSync(path, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n");
      }
    },
    read(ws, sinceMs = 0) {
      try {
        return parse(readFileSync(file(ws), "utf8")).filter((r) => r.at >= sinceMs);
      } catch {
        return [];
      }
    },
    workspaces() {
      try {
        return readdirSync(dir)
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => f.slice(0, -".jsonl".length))
          .sort();
      } catch {
        return [];
      }
    },
  };
}

export const historyDir = () => join(metaDir(), "history");

/** The store in use. The server, when it lands, is returned here. */
export const historyStore = (): HistoryStore => fileStore(historyDir());

/** The record for a Claude hook payload, or undefined for an event that is not recorded. */
export function claudeRecord(
  input: { hook_event_name?: string; tool_name?: string; tool_use_id?: string; tool_input?: { command?: unknown } },
  at = Date.now(),
): ClaudeRecord | undefined {
  const event = CLAUDE_EVENTS.find((e) => e === input.hook_event_name);
  if (!event) return undefined;
  const tool = event === "PreToolUse" || event === "PostToolUse" ? input.tool_name : undefined;
  const command = tool === "Bash" && typeof input.tool_input?.command === "string" ? input.tool_input.command : undefined;
  return {
    kind: "claude",
    at,
    event,
    ...(tool ? { tool } : {}),
    ...(tool && input.tool_use_id ? { id: input.tool_use_id } : {}),
    ...(command === undefined ? {} : { cls: classifyCommand(command) }),
  };
}

export interface Tally {
  count: number;
  ms: number;
}

export interface Summary {
  turns: number;
  /** Prompt to stop, summed. */
  turnMs: number;
  /** Turn time not spent in a tool or at a permission prompt. */
  modelMs: number;
  /** Tool time, apart from permission waits. */
  toolMs: number;
  /** Notification to the tool running, inside a turn. */
  permissionMs: number;
  /** Stop to the next prompt, when the gap is at most `awayAfterMs`. */
  userMs: number;
  /** Gaps between turns longer than `awayAfterMs`: the user left. */
  awayMs: number;
  tools: Record<string, Tally>;
  /** Bash tool time by command class. */
  bash: Partial<Record<CommandClass, Tally>>;
  /** `overbridge check` runs by class: count, and run time. */
  checks: Partial<Record<CommandClass, Tally & { failed: number; queuedMs: number }>>;
}

/** A gap between turns longer than this counts as away, not waiting. */
export const AWAY_AFTER_MS = 30 * 60_000;

const bump = (t: Tally | undefined, ms: number): Tally => ({ count: (t?.count ?? 0) + 1, ms: (t?.ms ?? 0) + ms });

/** Fold a workspace's records into time totals. Records need not be sorted. */
export function summarize(records: readonly HistoryRecord[], awayAfterMs = AWAY_AFTER_MS): Summary {
  const s: Summary = { turns: 0, turnMs: 0, modelMs: 0, toolMs: 0, permissionMs: 0, userMs: 0, awayMs: 0, tools: {}, bash: {}, checks: {} };
  let turnStart: number | undefined;
  let lastStop: number | undefined;
  let notifiedAt: number | undefined;
  const open = new Map<string, { at: number; tool: string; cls?: CommandClass }>();
  for (const r of [...records].sort((a, b) => a.at - b.at)) {
    if (r.kind === "check") {
      const prev = s.checks[r.cls];
      s.checks[r.cls] = { ...bump(prev, r.runMs), failed: (prev?.failed ?? 0) + (r.exit === 0 ? 0 : 1), queuedMs: (prev?.queuedMs ?? 0) + r.queuedMs };
      continue;
    }
    switch (r.event) {
      case "SessionStart":
      case "SessionEnd":
        turnStart = lastStop = notifiedAt = undefined;
        open.clear();
        break;
      case "UserPromptSubmit":
        if (lastStop !== undefined) {
          const gap = r.at - lastStop;
          if (gap <= awayAfterMs) s.userMs += gap;
          else s.awayMs += gap;
        }
        turnStart = r.at;
        lastStop = notifiedAt = undefined;
        open.clear();
        break;
      case "PreToolUse":
        if (turnStart !== undefined && r.id) open.set(r.id, { at: r.at, tool: r.tool ?? "?", ...(r.cls ? { cls: r.cls } : {}) });
        break;
      case "Notification":
        // an idle notification after the turn ended waits on nobody
        if (turnStart !== undefined && notifiedAt === undefined) notifiedAt = r.at;
        break;
      case "PostToolUse": {
        const started = r.id ? open.get(r.id) : undefined;
        if (!started || r.id === undefined) break;
        open.delete(r.id);
        // a permission prompt raised during this call is time waiting on the user, not in the tool
        const wait = notifiedAt !== undefined && notifiedAt >= started.at ? r.at - notifiedAt : 0;
        notifiedAt = undefined;
        const ms = Math.max(0, r.at - started.at - wait);
        s.permissionMs += wait;
        s.toolMs += ms;
        s.tools[started.tool] = bump(s.tools[started.tool], ms);
        if (started.cls) s.bash[started.cls] = bump(s.bash[started.cls], ms);
        break;
      }
      case "Stop":
        if (turnStart !== undefined) {
          s.turns++;
          s.turnMs += r.at - turnStart;
          lastStop = r.at;
        }
        turnStart = notifiedAt = undefined;
        open.clear();
        break;
    }
  }
  s.modelMs = Math.max(0, s.turnMs - s.toolMs - s.permissionMs);
  return s;
}
