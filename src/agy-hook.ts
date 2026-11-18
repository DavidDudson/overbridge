/**
 * Antigravity CLI (`agy`) hook payloads, translated to the Claude Code shape the guard and the agent-state hook
 * already read. agy sends camelCase fields (`hookEventName`, `toolCall: { name, args }`) and its own tool names
 * (`run_command`, `write_to_file`), and takes a hook's decision as JSON on stdout instead of exit code 2.
 * The agent hook imports this module, so it imports only `json.ts`.
 */
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

/** Argument names agy tools give a file or folder in, such as `TargetFile`, `AbsolutePath`, `DirectoryPath`, `SearchPath`. */
const PATH_ARG = /(?:Path|File|Directory|Dir)$/;

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

/** Every path an agy tool call names, from its path-like arguments. */
export function agyToolPaths(args: JsonObject): string[] {
  return Object.entries(args).flatMap(([k, v]) => (PATH_ARG.test(k) && isJsonString(v) && v ? [v] : []));
}

/**
 * agy's tool call as the Claude tool the guard knows: `run_command` as Bash, file writers as Write/Edit/MultiEdit
 * and readers as Read/LS/Grep/Glob, each with its paths under `paths`. A tool not listed keeps its own name, and
 * any path it names is still checked as a read (`Read`), so a new agy tool cannot step outside the workspace unseen.
 */
export function claudeTool(name: string, args: JsonObject) {
  const paths = agyToolPaths(args);

  if (name === SHELL_TOOL) {
    const command = str(args, "CommandLine") ?? "";
    const cwd = str(args, "Cwd");

    return { tool_name: "Bash", tool_input: cwd ? { command: `cd ${JSON.stringify(cwd)} && ${command}` } : { command } };
  }

  const known = WRITE_TOOLS.get(name) ?? READ_TOOLS.get(name);

  if (known) return { tool_name: known, tool_input: { paths } };

  return paths.length ? { tool_name: "Read", tool_input: { paths, agy_tool: name } } : { tool_name: name, tool_input: args };
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

      return !isJsonNumber(n) || n <= 1 ? "UserPromptSubmit" : undefined;
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

/** agy's PreToolUse answer: deny with the reason, or allow. */
export const agyToolDecision = (reason: string | undefined) => (reason ? { decision: "deny", reason } : { decision: "allow" });

/** agy's Stop answer that keeps the agent working, the equivalent of Claude's `{ decision: "block" }`. */
export const agyContinue = (reason: string) => ({ decision: "continue", reason });
