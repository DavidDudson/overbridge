import { appendFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, isJsonString, numberField, parseJson, type JsonObject, type JsonValue } from "./json";
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
export const CLAUDE_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Notification", "Stop", "SessionEnd"] as const;

export type ClaudeEvent = (typeof CLAUDE_EVENTS)[number];

/** A coarse class for a command, so history never needs to keep a Claude Bash call's text. */
export const COMMAND_CLASSES = ["test", "lint", "build", "typecheck", "format", "git", "other"] as const;

export type CommandClass = (typeof COMMAND_CLASSES)[number];

const CLASS_PATTERNS: readonly [CommandClass, RegExp][] = [
  ["git", /^\s*(git|gh)\b/],
  ["typecheck", /\b(typecheck|tsc|mypy|pyright|type-check)\b/],
  ["lint", /\b(lint|eslint|clippy|ruff|biome|shellcheck|statix)\b/],
  ["format", /\b(fmt|format|prettier|rustfmt|nixfmt|treefmt)\b/],
  ["test", /\b(test|tests|vitest|jest|pytest|spec|e2e)\b/],
  ["build", /\b(build|compile|bundle|nix build|cargo build|webpack|vite)\b/],
];

/** The class of a command line: the first pattern it matches, else `other`. */
export function classifyCommand(command: string): CommandClass {
  return CLASS_PATTERNS.find(([, re]) => re.test(command))?.[0] ?? "other";
}

/**
 * What a check command is, for display: its leading words up to the first flag, assignment or quote, at most four.
 * `API_TOKEN=x bun test --token=y` is `bun test`. Arguments are where secrets sit, so they are never kept.
 */
export function commandLabel(command: string): string {
  const words = command.trim().split(/\s+/);
  const start = words.findIndex((w) => !/^\w+=/.test(w));
  const label: string[] = [];

  for (const w of words.slice(start < 0 ? words.length : start)) {
    if (w.startsWith("-") || /[=:'"$]/.test(w) || label.length === 4) break;
    label.push(w);
  }

  return label.join(" ");
}

/** Programs whose second word is a subcommand, not an argument: `git status`, `cargo build`. */
const SUBCOMMAND_PROGRAMS = new Set(["git", "gh", "cargo", "nix", "docker", "kubectl", "systemctl", "go", "rustup", "brew", "terraform", "helm", "overbridge", "zellij", "tmux"]);

const SUBCOMMAND = /^[a-z][a-z0-9:_-]*$/;

/**
 * What a Claude Bash call is, for display and kept in history: the program (its basename) and, for a task runner,
 * package manager or a program in `SUBCOMMAND_PROGRAMS`, the task or subcommand. Every other word is an argument and is
 * dropped, since a secret passed as a bare argument cannot be told from any other word. Only the command that runs is
 * labelled: a leading `cd <dir> &&` is skipped and a pipeline or chain stops at its first command. Empty when unreadable.
 */
export function bashLabel(command: string): string {
  const segments = command.split(/&&|\|\||;|\||\n/).map((x) => x.trim()).filter(Boolean);
  const running = segments.find((x) => !/^cd(\s|$)/.test(x)) ?? segments[0] ?? "";
  const words = running.split(/\s+/).filter((w) => !/^\w+=/.test(w));
  const program = (words[0] ?? "").split("/").pop() ?? "";

  if (!/^[\w.+-]+$/.test(program)) return "";

  if (TASK_RUNNERS.has(program) || PACKAGE_MANAGERS.has(program)) {
    const task = commandGroup(running);

    return SUBCOMMAND.test(task) && task !== program ? `${program} ${task}` : program;
  }

  const sub = words[1];

  return SUBCOMMAND_PROGRAMS.has(program) && sub && SUBCOMMAND.test(sub) ? `${program} ${sub}` : program;
}

/** Words that name a secret: the value after one is never kept. */
const SECRET_FLAG = String.raw`--?[\w-]*(?:token|secret|passw|key|auth|cred)[\w-]*`;
const VALUE = String.raw`"[^"]*"|'[^']*'|[^\s'"]+`;

const REDACTIONS: readonly [RegExp, string][] = [
  // https://user:pw@host
  [/(\b[a-z][a-z0-9+.-]{0,15}:\/\/)[^/\s@'"]+@/gi, "$1***@"],
  // ?token=x, &api_key=x, X-Amz-Signature=x in a URL
  [/([?&;][\w-]*(?:token|secret|passw|key|auth|cred|sig)[\w-]*=)[^&\s'"]*/gi, "$1***"],
  // Authorization: Bearer x, Bearer x, Basic x
  [/(authorization:?\s*)(?:(?:bearer|basic|token)\s+)?[^\s'"]+/gi, "$1***"],
  [/\b(bearer|basic)\s+[^\s'"]+/gi, "$1 ***"],
  // NAME=value anywhere, quoted values included (`bash -c "API_TOKEN=x just check"`)
  [new RegExp(String.raw`(^|[\s'"])([A-Za-z_]\w*)=(?:${VALUE})?`, "g"), "$1$2=***"],
  // a secret-looking flag's value, `--token x` or `--api-key=x`
  [new RegExp(String.raw`(${SECRET_FLAG})(=|\s+)(?!-)(?:${VALUE})`, "gi"), "$1$2***"],
  // header and basic-auth arguments
  [new RegExp(String.raw`(-H|--header|--user)(=|\s*)(?:${VALUE})`, "g"), "$1$2***"],
  [/(\s-u\s*)[^\s'"]*:[^\s'"]*/g, "$1***"],
];

/**
 * A command line for history: the whole line with what looks like a secret blanked. Best effort, by pattern: it blanks
 * every `NAME=value`, URL credentials, `Authorization`/`Bearer`/`Basic` values, the value of a flag whose name looks
 * secret (`--token x`), secret-looking URL query parameters and the arguments of `-H`, `--header`, `--user` and `-u user:pass`.
 * A secret passed as a bare positional argument or after a flag like `-p` (a port, a package or a password), or one
 * inside an escaped quote, cannot be told apart from any other word and is kept. At most 500 characters.
 */
export function redactCommand(command: string): string {
  return REDACTIONS.reduce((text, [re, to]) => text.replace(re, to), command.trim().slice(0, 2000).replace(/\s+/g, " ")).slice(0, REDACTED_MAX_CHARS);
}

/** `redactCommand` keeps at most this many characters, so two commands alike up to here share one text. */
export const REDACTED_MAX_CHARS = 500;

/** Programs whose next word is the task they run: `just check`, `make lint`. */
const TASK_RUNNERS = new Set(["just", "make", "task", "nx", "turbo", "mise"]);

/** Package managers: `bun run lint`, `npm test`, `pnpm lint`. */
const PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn"]);

/** Flags that take the next word as their value, so it is not the task: `just --justfile ci.just check`. */
const VALUE_FLAGS = new Set(["-C", "-f", "-d", "-w", "--justfile", "--working-directory", "--directory", "-j", "-E", "-l", "--file", "--filter", "--cwd", "--prefix", "--workspace", "--set"]);

/** Words after a package manager that run another program: `bun x vitest`. */
const EXEC_WORDS = new Set(["run", "x", "exec", "dlx"]);

/** The words after a runner that are not flags (nor flag values). */
function runnerArgs(words: readonly string[]): string[] {
  const out: string[] = [];

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;

    if (VALUE_FLAGS.has(w)) i++;
    else if (!w.startsWith("-")) out.push(w);
  }

  return out;
}

/**
 * The group a check command belongs to, for display: the task it runs, so `nix develop --command just check` and
 * `just check` are both `check`. Other commands group under their label (`cargo clippy`).
 */
export function commandGroup(command: string): string {
  const words = command.trim().split(/\s+/).filter((w) => !/^\w+=/.test(w));
  const at = words.findIndex((w) => TASK_RUNNERS.has(w) || PACKAGE_MANAGERS.has(w));

  if (at >= 0) {
    const rest = runnerArgs(words.slice(at + 1));
    const task = PACKAGE_MANAGERS.has(words[at]!) && rest[0] && EXEC_WORDS.has(rest[0]) ? rest[1] : rest[0];

    if (task && !/[='"$]/.test(task)) return task;
  }

  return commandLabel(words.join(" ")) || command.trim().split(/\s+/)[0] || "?";
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
  /** What the call ran, for display: `bashLabel` of a Bash command (a program and at most a subcommand), the name of a Skill. */
  label?: string;
}

export interface CheckRecord {
  kind: "check";
  /** Epoch ms when the run ended. */
  at: number;
  repo: string;
  /** `commandLabel` of the command: its leading words. */
  command: string;
  /** The whole command line, secrets blanked (`redactCommand`). Absent on records from before it was kept. */
  full?: string;
  /** `commandGroup` of the command. Absent on older records: `command` stands in. */
  group?: string;
  cls: CommandClass;
  /** Time waiting in the check queue. */
  queuedMs: number;
  /** Time the command ran. */
  runMs: number;
  exit: number;
  /** Someone stopped the run (the @checks tab, Ctrl-C): not a failure of the command. */
  killed?: true;
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

/** A parsed line is ours when it has a numeric `at` and a known kind; the other fields come from `append`, which serialises a HistoryRecord. */
const isHistoryRecord = (raw: JsonValue): raw is JsonObject & HistoryRecord =>
  isJsonObject(raw) && numberField(raw, "at") !== undefined && (raw.kind === "claude" || raw.kind === "check");

/** One JSON line per record in `<dir>/<ws>.jsonl`. A line is one `appendFileSync`, so concurrent writers do not interleave. */
export function fileStore(dir: string, maxBytes = MAX_FILE_BYTES): HistoryStore {
  const file = (ws: string) => historyFile(ws, dir);

  const parse = (text: string): HistoryRecord[] =>
    text.split("\n").flatMap((line) => {
      if (!line) return [];

      try {
        const raw = parseJson(line);

        return isHistoryRecord(raw) ? [raw] : [];
      } catch {
        return [];
      }
    });

  return {
    append(ws, record) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = file(ws);
      appendFileSync(path, JSON.stringify(record) + "\n", { mode: 0o600 });

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

/** The file `fileStore` keeps `ws`'s records in. */
export const historyFile = (ws: string, dir = historyDir()) => join(dir, `${safeName(ws)}.jsonl`);

/** The store in use. The server, when it lands, is returned here. */
export const historyStore = (): HistoryStore => fileStore(historyDir());

/** The parts of a Claude hook payload that history reads. */
export interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: JsonObject;
}

/** The record for a Claude hook payload, or undefined for an event that is not recorded. */
export function claudeRecord(input: HookPayload, at = Date.now()): ClaudeRecord | undefined {
  const event = CLAUDE_EVENTS.find((e) => e === input.hook_event_name);

  if (!event) return undefined;
  const tool = event === "PreToolUse" || event === "PostToolUse" || event === "PostToolUseFailure" ? input.tool_name : undefined;
  const text = input.tool_input?.command;
  const command = tool === "Bash" && isJsonString(text) ? text : undefined;
  const skillName = input.tool_input?.skill;
  const skill = tool === "Skill" && isJsonString(skillName) ? skillName.slice(0, 80) : undefined;
  const label = command === undefined ? skill : bashLabel(command) || undefined;
  const record: ClaudeRecord = { kind: "claude", at, event };

  if (tool) record.tool = tool;

  if (tool && input.tool_use_id) record.id = input.tool_use_id;

  if (command !== undefined) record.cls = classifyCommand(command);

  if (label) record.label = label;

  return record;
}

/** A tool call that has started and not yet finished. */
interface OpenCall {
  at: number;
  tool: string;
  cls?: CommandClass;
  label?: string;
}

function openCall(r: ClaudeRecord): OpenCall {
  const call: OpenCall = { at: r.at, tool: r.tool ?? "?" };

  if (r.cls) call.cls = r.cls;

  if (r.label) call.label = r.label;

  return call;
}

export interface Tally {
  count: number;
  ms: number;
}

/** Check runs of one group: what `just check` costs, however it was invoked. */
export interface GroupTally extends Tally {
  failed: number;
  queuedMs: number;
  cls: CommandClass;
  /** The slowest single run. */
  maxMs: number;
  /** The distinct full command lines, newest first, at most three. */
  fulls: string[];
}

/** A run that ended non-zero on its own; a killed run is not the command's failure. */
export const checkFailed = (r: Pick<CheckRecord, "exit" | "killed">) => r.exit !== 0 && !r.killed;

/** Add a check run to `groups`. */
export function addCheck(groups: Record<string, GroupTally>, r: CheckRecord): void {
  const key = r.group ?? r.command;
  const prev = groups[key];
  const full = r.full ?? r.command;
  groups[key] = {
    count: (prev?.count ?? 0) + 1,
    ms: (prev?.ms ?? 0) + r.runMs,
    failed: (prev?.failed ?? 0) + (checkFailed(r) ? 1 : 0),
    queuedMs: (prev?.queuedMs ?? 0) + r.queuedMs,
    cls: r.cls,
    maxMs: Math.max(prev?.maxMs ?? 0, r.runMs),
    fulls: [full, ...(prev?.fulls ?? []).filter((f) => f !== full)].slice(0, 3),
  };
}

/** One repo's check runs, whichever workspace ran them. */
export interface RepoSummary {
  repo: string;
  count: number;
  ms: number;
  queuedMs: number;
  failed: number;
  groups: Record<string, GroupTally>;
}

/** Fold check records from every workspace into one summary per repo. Records need not be sorted. */
export function summarizeRepos(records: readonly HistoryRecord[]): RepoSummary[] {
  const repos = new Map<string, RepoSummary>();

  for (const r of [...records].sort((a, b) => a.at - b.at)) {
    if (r.kind !== "check") continue;
    const t = repos.get(r.repo) ?? { repo: r.repo, count: 0, ms: 0, queuedMs: 0, failed: 0, groups: {} };
    t.count++;
    t.ms += r.runMs;
    t.queuedMs += r.queuedMs;

    if (checkFailed(r)) t.failed++;
    addCheck(t.groups, r);
    repos.set(r.repo, t);
  }

  return [...repos.values()];
}

/** Claude Bash calls of one command label: what it was (`cls`), how often, how long. */
export interface CommandTally extends Tally {
  cls: CommandClass;
  failed: number;
  /** The slowest single call. */
  maxMs: number;
}

export interface Summary {
  /** `SessionStart` events: a resume, clear or compaction starts one too. */
  sessions: number;
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
  /** Bash tool time by command label (`bun test`), never the arguments. Calls recorded before labels existed are `(<class>)`. */
  commands: Record<string, CommandTally>;
  /** Skill invocations by skill name. */
  skills: Record<string, Tally>;
  /** `overbridge check` runs by class: count, and run time. */
  checks: Partial<Record<CommandClass, Tally & { failed: number; queuedMs: number }>>;
  /** `overbridge check` runs by group (`check`, `lint`): what the user can optimise. */
  groups: Record<string, GroupTally>;
}

/** A summary with nothing in it. */
export const emptySummary = (): Summary => ({ sessions: 0, turns: 0, turnMs: 0, modelMs: 0, toolMs: 0, permissionMs: 0, userMs: 0, awayMs: 0, tools: {}, bash: {}, commands: {}, skills: {}, checks: {}, groups: {} });

const addTally = <T extends Tally>(into: Partial<Record<string, T>>, key: string, t: T, join: (a: T, b: T) => T) => {
  const prev = into[key];
  into[key] = prev ? join(prev, t) : { ...t };
};

const plus = (a: Tally, b: Tally) => ({ count: a.count + b.count, ms: a.ms + b.ms });

/** Sum summaries into one: the dashboard over every workspace. Tool time adds across workspaces, which run side by side. */
export function mergeSummaries(list: readonly Summary[]): Summary {
  const out = emptySummary();

  for (const s of list) {
    out.sessions += s.sessions;
    out.turns += s.turns;
    out.turnMs += s.turnMs;
    out.modelMs += s.modelMs;
    out.toolMs += s.toolMs;
    out.permissionMs += s.permissionMs;
    out.userMs += s.userMs;
    out.awayMs += s.awayMs;

    for (const [k, t] of Object.entries(s.tools)) addTally(out.tools, k, t, plus);

    for (const [k, t] of Object.entries(s.skills)) addTally(out.skills, k, t, plus);

    for (const [k, t] of Object.entries(s.bash)) addTally(out.bash, k, t, plus);

    for (const [k, t] of Object.entries(s.commands)) addTally(out.commands, k, t, (a, b): CommandTally => ({ ...plus(a, b), cls: a.cls, failed: a.failed + b.failed, maxMs: Math.max(a.maxMs, b.maxMs) }));

    for (const [k, t] of Object.entries(s.checks)) {
      if (t) addTally(out.checks, k, t, (a, b) => ({ ...plus(a, b), failed: a.failed + b.failed, queuedMs: a.queuedMs + b.queuedMs }));
    }

    for (const [k, g] of Object.entries(s.groups)) {
      addTally(out.groups, k, g, (a, b): GroupTally => ({ ...plus(a, b), failed: a.failed + b.failed, queuedMs: a.queuedMs + b.queuedMs, cls: a.cls, maxMs: Math.max(a.maxMs ?? 0, b.maxMs ?? 0), fulls: [...new Set([...a.fulls, ...b.fulls])].slice(0, 3) }));
    }
  }

  return out;
}

/** A gap between turns longer than this counts as away, not waiting. */
export const AWAY_AFTER_MS = 30 * 60_000;

const bump = (t: Tally | undefined, ms: number): Tally => ({ count: (t?.count ?? 0) + 1, ms: (t?.ms ?? 0) + ms });

/** Total length covered by `spans`, counting overlapping time once. */
function unionMs(spans: [number, number][]): number {
  let total = 0;
  let end = -Infinity;

  for (const [from, to] of spans.sort((a, b) => a[0] - b[0])) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }

  return total;
}

/** Fold a workspace's records into time totals. Records need not be sorted. */
export function summarize(records: readonly HistoryRecord[], awayAfterMs = AWAY_AFTER_MS): Summary {
  const s = emptySummary();
  let turnStart: number | undefined;
  let lastStop: number | undefined;
  let notifiedAt: number | undefined;
  const open = new Map<string, OpenCall>();
  // parallel tool calls overlap, so tool time is the union of the intervals, not their sum
  const spans: [number, number][] = [];

  for (const r of [...records].sort((a, b) => a.at - b.at)) {
    if (r.kind === "check") {
      const prev = s.checks[r.cls];
      s.checks[r.cls] = { ...bump(prev, r.runMs), failed: (prev?.failed ?? 0) + (checkFailed(r) ? 1 : 0), queuedMs: (prev?.queuedMs ?? 0) + r.queuedMs };
      addCheck(s.groups, r);
      continue;
    }

    switch (r.event) {
      case "SessionStart":
      case "SessionEnd":
        if (r.event === "SessionStart") s.sessions++;
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
        if (turnStart !== undefined && r.id) open.set(r.id, openCall(r));
        break;
      case "Notification":
        // an idle notification after the turn ended waits on nobody
        if (turnStart !== undefined && notifiedAt === undefined) notifiedAt = r.at;
        break;
      case "PostToolUse":
      case "PostToolUseFailure": {
        const started = r.id ? open.get(r.id) : undefined;

        if (!started || r.id === undefined) break;
        open.delete(r.id);
        // a permission prompt raised during this call is time waiting on the user, not in the tool
        const wait = notifiedAt !== undefined && notifiedAt >= started.at ? r.at - notifiedAt : 0;
        notifiedAt = undefined;
        const ms = Math.max(0, r.at - started.at - wait);
        s.permissionMs += wait;
        spans.push([started.at, started.at + ms]);
        s.tools[started.tool] = bump(s.tools[started.tool], ms);

        if (started.cls) {
          s.bash[started.cls] = bump(s.bash[started.cls], ms);
          const key = started.label ?? `(${started.cls})`;
          const prev = s.commands[key];
          s.commands[key] = { ...bump(prev, ms), cls: started.cls, failed: (prev?.failed ?? 0) + (r.event === "PostToolUseFailure" ? 1 : 0), maxMs: Math.max(prev?.maxMs ?? 0, ms) };
        }

        if (started.tool === "Skill" && started.label) s.skills[started.label] = bump(s.skills[started.label], ms);
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

  s.toolMs = unionMs(spans);
  s.modelMs = Math.max(0, s.turnMs - s.toolMs - s.permissionMs);

  return s;
}
