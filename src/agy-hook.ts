/** agy hook payloads translated to the Claude shape the guard and the agent-state hook read. Imports only `json.ts`: the per-call hook loads it. */
import { isJsonNumber, isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./json";

/** agy tools that change a file, by the Claude tool the guard checks them as. */
const WRITE_TOOLS = new Map([
  ["write_file", "Write"],
  ["edit_file", "Edit"],
  ["write_to_file", "Write"],
  ["replace_file_content", "Edit"],
  ["multi_replace_file_content", "MultiEdit"],
]);

/** agy tools that read files or folders, by the Claude tool the guard checks them as. */
const READ_TOOLS = new Map([
  ["read_file", "Read"],
  ["view_file", "Read"],
  ["view_file_outline", "Read"],
  ["list_dir", "LS"],
  ["grep_search", "Grep"],
  ["find_by_name", "Glob"],
]);

const SHELL_TOOL = "run_command";

/** agy's tool that runs a script (`Script` or `ScriptPath`); the guard checks every string in the call as a shell command. */
const SCRIPT_TOOL = "run_workflow";

/** Argument names that hold free text, such as a prompt or a message, which can start with `/` without naming a path. */
const FREE_TEXT_ARG = /^(?:message|prompt|systemprompt|instructions|description|summary|toolsummary|title|query)$/i;

/** A path anywhere in a script, after any character that cannot end a word: a quote, a backtick, a bracket, an operator. */
const SCRIPT_PATH = /(?<![\w.-])(?:~|\.\.|\/)[^\s'"`;|&()<>,+[\]{}]*/g;

/** A string literal in a script: single-quoted, double-quoted or a template literal. */
const SCRIPT_LITERAL = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;

/** A script that names the workspace's `.agents` folder, which overbridge manages. */
const AGENTS_DIR = /(?<![\w-])\.agents\b/;

/** Argument names agy tools give a file or folder in, such as `TargetFile`, `AbsolutePath`, `DirectoryPath`, `SearchPath`, in any case. */
const PATH_ARG = /(?:path|file|directory|dir|uri|workspace)s?$/i;

/** A one-line string value that reads as a path whatever its key: absolute, home-relative, or holding a `..` segment. */
const PATH_VALUE = /^(?:~|\/|file:\/\/|[^\n]*(?:^|\/)\.\.(?:\/|$))[^\n]*$/;

/** A `file://` URI as the path the guard checks. */
const asPath = (v: string) => v.replace(/^file:\/\//, "");

/** agy tools that name no file and run no command, so the guard has nothing to check. Any other unknown tool has its paths checked as writes. */
const NO_PATH_TOOLS = new Set(["search_web", "read_url_content", "command_status", "read_terminal", "ask_question", "manage_task", "manage_subagents"]);

/** The guard's tool name for an agy call it cannot read safely; the guard denies it with `tool_input.reason`. */
export const UNREADABLE_TOOL = "AgyUnreadable";

/** The Claude hook fields the guard and the agent-state hook read. */
export interface ClaudeHookInput {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: JsonObject;
  stop_hook_active?: boolean;
}

const str = (o: JsonObject | undefined, k: string): string | undefined => {
  const v = o?.[k];

  return isJsonString(v) ? v : undefined;
};

/** How hard `agyToolPaths` looks: by key only (a known tool, whose content arguments may start with `/`), or by key and by value (an unknown tool). */
export const PathScan = { Keys: "keys", KeysAndValues: "keys-and-values" } as const;

export type PathScan = (typeof PathScan)[keyof typeof PathScan];

/** Every path an agy tool call names, through arrays and nested objects: values under a path-like key, and with `KeysAndValues` any one-line value outside free text that reads as a path. */
export function agyToolPaths(args: JsonValue | undefined, scan: PathScan, key = ""): string[] {
  if (isJsonString(args)) {
    const byValue = scan === PathScan.KeysAndValues && !FREE_TEXT_ARG.test(key) && PATH_VALUE.test(args);

    return args && (PATH_ARG.test(key) || byValue) ? [asPath(args)] : [];
  }

  if (Array.isArray(args)) return args.flatMap((v) => agyToolPaths(v, scan, key));

  if (isJsonObject(args)) return Object.entries(args).flatMap(([k, v]) => agyToolPaths(v, scan, k));

  return [];
}

/** `dir` as an absolute path, a relative one taken from the hook's `cwd`. */
const underCwd = (base: string | undefined, dir: string) => (dir.startsWith("/") || dir.startsWith("~") || !base ? dir : `${base}/${dir}`);

/** Every string in an agy argument tree, keys excluded. */
const strings = (v: JsonValue | undefined): string[] => {
  if (isJsonString(v)) {
    return [v];
  }

  if (Array.isArray(v)) {
    return v.flatMap(strings);
  }

  return isJsonObject(v) ? Object.values(v).flatMap(strings) : [];
};

/** The guard's tool call: a Claude tool name, its input, and the folder a command runs in when agy gave one. */
export type ClaudeToolCall = Required<Pick<ClaudeHookInput, "tool_name" | "tool_input">> & Pick<ClaudeHookInput, "cwd">;

const unreadable = (name: string, reason: string): ClaudeToolCall => ({ tool_name: UNREADABLE_TOOL, tool_input: { agy_tool: name, reason } });

/** A shell command for the guard, in `given` (agy's `Cwd`, taken from the hook's `cwd` when relative) when there is one. */
const bashCall = (command: string, given: string | undefined, base: string | undefined): ClaudeToolCall =>
  given ? { tool_name: "Bash", tool_input: { command }, cwd: underCwd(base, given) } : { tool_name: "Bash", tool_input: { command } };

/**
 * agy's tool call as the Claude tool the guard knows. A shell or file tool whose command or path is not where
 * overbridge expects it is unreadable (denied). An unknown tool has every path it names checked as a write; one
 * that names no path the scan can find is allowed, so its arguments are only as safe as that scan.
 */
export function claudeTool(name: string, args: JsonObject, base?: string): ClaudeToolCall {
  if (name === SHELL_TOOL) {
    const command = str(args, "CommandLine");

    if (!command) return unreadable(name, `agy's ${name} call has no CommandLine, so overbridge cannot check it`);

    // the command stays as agy sent it, so anchored `guard.deny` rules and history read it; the guard checks `cwd` itself
    return bashCall(command, str(args, "Cwd"), base);
  }

  if (name === SCRIPT_TOOL) return scriptCall(name, args, base);

  const known = WRITE_TOOLS.get(name) ?? READ_TOOLS.get(name);
  const paths = agyToolPaths(args, known ? PathScan.Keys : PathScan.KeysAndValues);

  if (known) return paths.length ? { tool_name: known, tool_input: { paths } } : unreadable(name, `agy's ${name} call names no path overbridge can find, so it cannot check it`);

  if (NO_PATH_TOOLS.has(name)) return { tool_name: name, tool_input: args };

  return { tool_name: "Write", tool_input: { paths, agy_tool: name } };
}

/**
 * `run_workflow` as a shell command over every string in the call, with each path a script names on a line of its
 * own, since a script's paths sit in quotes, template literals and calls that the shell scan does not split on, and
 * each string literal as a command of its own (`commands`), since a script can run one. Like
 * the shell scan it is best effort: a path built at runtime passes to agy's own permission check.
 */
function scriptCall(name: string, args: JsonObject, base: string | undefined): ClaudeToolCall {
  if (!str(args, "Script") && !str(args, "ScriptPath")) {
    return unreadable(name, `agy's ${name} call has no Script or ScriptPath, so overbridge cannot check it`);
  }

  const text = strings(args);

  if (text.some((s) => AGENTS_DIR.test(s))) {
    return unreadable(name, "workspace .agents config is managed by overbridge");
  }

  const found = text.flatMap((s) => [...s.matchAll(SCRIPT_PATH)].map((m) => m[0]));
  const literals = text.flatMap((s) => [...s.matchAll(SCRIPT_LITERAL)].map((m) => m[1] ?? m[2] ?? m[3] ?? ""));
  const call = bashCall([...text, ...found].join("\n"), str(args, "Cwd"), base);

  return literals.length ? { ...call, tool_input: { ...call.tool_input, commands: literals } } : call;
}

/** Claude's name for an agy hook event; PreInvocation runs per model call, so only the first of a turn is a prompt. */
function claudeEvent(event: string, raw: JsonObject): string | undefined {
  switch (event) {
    case "SessionStart":
    case "PreToolUse":
    case "Stop":
      return event;
    case "PostToolUse":
      return raw.error !== undefined && raw.error !== null && raw.error !== "" ? "PostToolUseFailure" : "PostToolUse";
    case "PreInvocation": {
      const n = raw.invocationNum;

      // a missing count is not a new prompt: PreInvocation runs on every model call
      return isJsonNumber(n) && n <= 1 ? "UserPromptSubmit" : undefined;
    }

    default:
      return undefined;
  }
}

/** An agy hook payload in Claude's shape; an event overbridge does not track has no `hook_event_name`. */
export function fromAgy(raw: JsonValue): ClaudeHookInput {
  if (!isJsonObject(raw)) return {};
  const event = claudeEvent(str(raw, "hookEventName") ?? "", raw);
  const out: ClaudeHookInput = {};

  if (event) out.hook_event_name = event;
  const session = str(raw, "conversationId");

  if (session) out.session_id = session;
  const cwd = str(raw, "cwd");

  if (cwd) out.cwd = cwd;

  if (raw.continuationActive === true || raw.continuation_active === true) out.stop_hook_active = true;
  const call = isJsonObject(raw.toolCall) ? raw.toolCall : undefined;
  const name = str(call, "name");

  if (call && name) {
    Object.assign(out, claudeTool(name, isJsonObject(call.args) ? call.args : {}, cwd));
    const id = str(call, "id");

    if (id) out.tool_use_id = id;
  }

  return out;
}

/** agy's PreToolUse answer as text to print: a deny with its reason, or nothing to leave the call to agy's own check, since agy reads `{}` as a deny. */
export const agyToolDecision = (reason: string | undefined): string => (reason ? JSON.stringify({ decision: "deny", reason }) : "");

/** A hook's answer that keeps the agent working after a Stop: Claude's `block`, agy's `continue`. */
export interface HookReply {
  decision: "block" | "continue";
  reason: string;
}

/** agy's Stop answer that keeps the agent working, the equivalent of Claude's `{ decision: "block" }`. */
export const agyContinue = (reason: string): HookReply => ({ decision: "continue", reason });
