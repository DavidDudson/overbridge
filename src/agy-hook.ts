/** agy hook payloads translated to the Claude shape the guard and the agent-state hook read. Imports only `json.ts`: the per-call hook loads it. */
import { isJsonNumber, isJsonObject, isJsonString, type JsonObject, type JsonValue } from "./json";

/** agy tools that change a file, by the Claude tool the guard checks them as. */
const WRITE_TOOLS = new Map([
  ["write_to_file", "Write"],
  ["replace_file_content", "Edit"],
  ["multi_replace_file_content", "MultiEdit"],
]);

/** agy tools that read files or folders, by the Claude tool the guard checks them as. */
const READ_TOOLS = new Map([
  ["view_file", "Read"],
  ["view_file_outline", "Read"],
  ["list_dir", "LS"],
  ["grep_search", "Grep"],
  ["find_by_name", "Glob"],
]);

const SHELL_TOOL = "run_command";

/** Argument names agy tools give a file or folder in, such as `TargetFile`, `AbsolutePath`, `DirectoryPath`, `SearchPath`, in any case. */
const PATH_ARG = /(?:path|file|directory|dir|uri)s?$/i;

/** A one-line string value that reads as a path whatever its key: absolute, home-relative, or holding a `..` segment. */
const PATH_VALUE = /^(?:~|\/|file:\/\/|[^\n]*(?:^|\/)\.\.(?:\/|$))[^\n]*$/;

/** A `file://` URI as the path the guard checks. */
const asPath = (v: string) => v.replace(/^file:\/\//, "");

/** agy tools that name no file and run no command, so the guard has nothing to check. Any other unknown tool has its paths checked as writes. */
const NO_PATH_TOOLS = new Set(["search_web", "read_url_content", "command_status", "read_terminal"]);

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

/** Every path an agy tool call names, through arrays and nested objects: values under a path-like key, and with `KeysAndValues` any one-line value that reads as a path. */
export function agyToolPaths(args: JsonValue | undefined, scan: PathScan, key = ""): string[] {
  if (isJsonString(args)) return args && (PATH_ARG.test(key) || (scan === PathScan.KeysAndValues && PATH_VALUE.test(args))) ? [asPath(args)] : [];

  if (Array.isArray(args)) return args.flatMap((v) => agyToolPaths(v, scan, key));

  if (isJsonObject(args)) return Object.entries(args).flatMap(([k, v]) => agyToolPaths(v, scan, k));

  return [];
}

const unreadable = (name: string, reason: string) => ({ tool_name: UNREADABLE_TOOL, tool_input: { agy_tool: name, reason } });

/**
 * agy's tool call as the Claude tool the guard knows. A shell or file tool whose command or path is not where
 * overbridge expects it is unreadable (denied). An unknown tool has every path it names checked as a write; one
 * that names no path the scan can find is allowed, so its arguments are only as safe as that scan.
 */
export function claudeTool(name: string, args: JsonObject): Required<Pick<ClaudeHookInput, "tool_name" | "tool_input">> {
  if (name === SHELL_TOOL) {
    const command = str(args, "CommandLine");

    if (!command) return unreadable(name, `agy's ${name} call has no CommandLine, so overbridge cannot check it`);
    const cwd = str(args, "Cwd");

    return { tool_name: "Bash", tool_input: { command: cwd ? `cd ${JSON.stringify(cwd)} && ${command}` : command } };
  }

  const known = WRITE_TOOLS.get(name) ?? READ_TOOLS.get(name);
  const paths = agyToolPaths(args, known ? PathScan.Keys : PathScan.KeysAndValues);

  if (known) return paths.length ? { tool_name: known, tool_input: { paths } } : unreadable(name, `agy's ${name} call names no path overbridge can find, so it cannot check it`);

  if (NO_PATH_TOOLS.has(name)) return { tool_name: name, tool_input: args };

  return { tool_name: "Write", tool_input: { paths, agy_tool: name } };
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
    Object.assign(out, claudeTool(name, isJsonObject(call.args) ? call.args : {}));
    const id = str(call, "id");

    if (id) out.tool_use_id = id;
  }

  return out;
}

/** agy's PreToolUse answer: deny with the reason, or no decision, since agy's `allow` would skip its own permission prompt. */
export const agyToolDecision = (reason: string | undefined) => (reason ? { decision: "deny", reason } : {});

/** A hook's answer that keeps the agent working after a Stop: Claude's `block`, agy's `continue`. */
export interface HookReply {
  decision: "block" | "continue";
  reason: string;
}

/** agy's Stop answer that keeps the agent working, the equivalent of Claude's `{ decision: "block" }`. */
export const agyContinue = (reason: string): HookReply => ({ decision: "continue", reason });
