/**
 * The orchestration tab's guard. The orchestrator coordinates: it reads, checks status and starts workspaces.
 * All work happens in a workspace, so everything outside an allow list is blocked, failing closed: an unknown
 * tool, command or shell construct is refused.
 */
import type { HookInput } from "./guard";

export const START_HINT =
  'All work happens in a workspace: start one with `overbridge start <repo> <id> --prompt "<the request>"`, or ' +
  '`overbridge start <repo> --task <slug> --prompt "<the request>"` when there is no item yet.';

const blocked = (what: string) => `the orchestrator only coordinates, so ${what} is not allowed here. ${START_HINT}`;

/**
 * Tools that cannot change anything, whose own tool calls come back through this hook (Agent, Skill), or that
 * only talk to other Claude sessions (ListAgents, SendMessage), which run their own guards.
 */
const ALLOWED_TOOLS = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "LSP",
  "WebFetch",
  "WebSearch",
  "ToolSearch",
  "AskUserQuestion",
  "TodoWrite",
  "Agent",
  "Task",
  "Skill",
  "EnterPlanMode",
  "ExitPlanMode",
  "BashOutput",
  "ListAgents",
  "SendMessage",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
]);

/** MCP tools whose action names a read. Anything else from an MCP server could write. */
const MCP_READ = /^mcp__.+__(?:get|search|list|read|fetch|view|lookup|query|find)[A-Za-z_]*$/i;

/** Utilities that only read or print, each with the flags that would let it write or run a command. */
const READ_UTILS: Record<string, readonly string[]> = {
  ls: [],
  eza: [],
  tree: [],
  cat: [],
  bat: [],
  head: [],
  tail: [],
  rg: ["--pre"],
  grep: [],
  wc: [],
  jq: [],
  pwd: [],
  echo: [],
  printf: [],
  cd: [],
  which: [],
  file: [],
  stat: [],
  du: [],
  dust: [],
  date: [],
  cut: [],
  tr: [],
  sort: ["-o", "--output"],
  fd: ["-x", "--exec", "-X", "--exec-batch"],
  find: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"],
};

/** `git` verbs that read. `gitVerbReason` narrows the ones that can also write. */
const GIT_READ = new Set([
  "status",
  "log",
  "show",
  "diff",
  "rev-parse",
  "ls-files",
  "ls-remote",
  "blame",
  "describe",
  "shortlog",
  "cat-file",
  "merge-base",
  "grep",
  "fetch",
  "branch",
  "tag",
  "remote",
  "stash",
  "worktree",
  "config",
  "reflog",
]);

/** `gh` command groups and their read-only subcommands. An empty list allows the whole group. */
const GH_READ: Record<string, readonly string[]> = {
  pr: ["list", "view", "diff", "checks", "status"],
  issue: ["list", "view", "status"],
  repo: ["list", "view"],
  run: ["list", "view", "watch"],
  workflow: ["list", "view"],
  release: ["list", "view"],
  search: [],
  status: [],
  auth: ["status"],
  stack: ["view"],
  api: [],
};

/**
 * `overbridge` subcommands for reading and for managing workspaces. Ones that change a branch, PR or item
 * (`checkout`, `pr`, `item create|edit`) belong to a workspace.
 */
const OVERBRIDGE_ALLOWED: Record<string, readonly string[]> = {
  status: [],
  whoami: [],
  next: [],
  start: [],
  rm: [],
  icebox: [],
  thaw: [],
  release: [],
  up: [],
  layout: [],
  sync: [],
  diff: [],
  help: [],
  "--help": [],
  "-h": [],
  version: [],
  "--version": [],
  repo: ["ls", "add"],
  item: ["view", "from-branch", "branch", "assigned"],
  config: ["get", "check", "show"],
  ext: [],
};

/** Redirections that cannot write a file: to another descriptor or to /dev/null. */
const SAFE_REDIRECT = /^>>?\s*(?:&\d|\/dev\/null(?![^\s;&|]))/;

export type Split = { segments: string[][] } | { reason: string };

/**
 * Split a shell command into simple commands (on `;`, `&&`, `||`, `|`, `&` and newlines), each a list of words
 * with quotes removed. Refuses what a word list cannot show safely: command or process substitution, and
 * redirection that could write a file.
 */
export function splitCommand(cmd: string): Split {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | undefined;
  const endWord = () => {
    if (inWord) {
      words.push(word);
    }
    word = "";
    inWord = false;
  };
  const endSegment = () => {
    endWord();
    if (words.length) {
      segments.push(words);
    }
    words = [];
  };

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    const next = cmd[i + 1];
    if (quote === "'") {
      if (c === "'") {
        quote = undefined;
      } else {
        word += c;
      }
      continue;
    }
    if (c === "`" || (c === "$" && next === "(")) {
      return { reason: blocked("command substitution") };
    }
    if (quote === '"') {
      if (c === '"') {
        quote = undefined;
      } else if (c === "\\" && next !== undefined) {
        word += cmd[++i];
      } else {
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && next !== undefined) {
      word += cmd[++i];
      inWord = true;
    } else if ((c === "<" || c === ">") && next === "(") {
      return { reason: blocked("process substitution") };
    } else if (c === "<") {
      if (next === ">") {
        return { reason: blocked("redirection") };
      }
      endWord();
    } else if (c === ">") {
      const safe = SAFE_REDIRECT.exec(cmd.slice(i));
      if (!safe) {
        return { reason: blocked("redirection to a file") };
      }
      // the `2` of `2>&1` names a descriptor, not an argument
      if (inWord && /^\d$/.test(word)) {
        word = "";
        inWord = false;
      }
      endWord();
      i += safe[0].length - 1;
    } else if (c === ";" || c === "|" || c === "&" || c === "\n") {
      endSegment();
      if ((c === "|" || c === "&") && next === c) {
        i++;
      }
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote) {
    return { reason: blocked("an unterminated quote") };
  }
  endSegment();
  return { segments };
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const hasPositional = (args: readonly string[]) => args.some((a) => !a.startsWith("-"));

/** Index of the verb after git's global options, or a reason when an option could run something. */
function gitVerbIndex(args: readonly string[]): number | string {
  // `-c key=value` can define an alias that runs any command, so only options that pick a directory pass
  const withValue = new Set(["-C", "--git-dir", "--work-tree"]);
  const alone = /^(?:--no-pager|--git-dir=.+|--work-tree=.+)$/;
  let i = 0;
  while (i < args.length && args[i]!.startsWith("-")) {
    const a = args[i]!;
    if (withValue.has(a)) {
      i += 2;
    } else if (alone.test(a)) {
      i += 1;
    } else {
      return blocked(`\`git ${a}\``);
    }
  }
  return i;
}

function gitVerbReason(verb: string, rest: readonly string[]): string | undefined {
  const sub = rest[0];
  const refused = blocked(`\`git ${[verb, ...rest].join(" ")}\``);
  switch (verb) {
    case "branch":
    case "tag": {
      const listing = rest.some((a) => a === "--list" || a === "-l");
      const writes = rest.some((a) =>
        /^(?:-[dDmMcCfu]$|--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))/.test(a),
      );
      return writes || (!listing && hasPositional(rest)) ? refused : undefined;
    }
    case "remote":
      return !sub || sub === "-v" || sub === "show" || sub === "get-url" ? undefined : refused;
    case "stash":
      return sub === "list" || sub === "show" ? undefined : refused;
    case "worktree":
      return sub === "list" ? undefined : refused;
    case "config":
      return rest.some((a) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(a)) ? undefined : refused;
    case "reflog":
      return !sub || sub === "show" || sub.startsWith("-") ? undefined : refused;
    case "fetch":
      // a refspec with `:` writes a local branch
      return rest.some((a) => a.includes(":")) ? refused : undefined;
    default:
      return undefined;
  }
}

function gitReason(args: readonly string[]): string | undefined {
  const at = gitVerbIndex(args);
  if (typeof at === "string") {
    return at;
  }
  const verb = args[at];
  if (!verb || !GIT_READ.has(verb)) {
    return blocked(`\`git ${verb ?? ""}\``.trim());
  }
  return gitVerbReason(verb, args.slice(at + 1));
}

function ghApiReason(args: readonly string[]): string | undefined {
  const methodAt = args.findIndex((a) => a === "-X" || a === "--method");
  const method = methodAt >= 0 ? args[methodAt + 1] : args.map((a) => /^(?:-X|--method=)(.+)$/.exec(a)?.[1]).find(Boolean);
  if (method !== undefined && method.toUpperCase() !== "GET") {
    return blocked(`\`gh api --method ${method}\``);
  }
  if (args.some((a) => /^(?:-[fF]|--field|--raw-field|--input)/.test(a))) {
    return blocked("`gh api` with a request body");
  }
  return undefined;
}

function ghReason(args: readonly string[]): string | undefined {
  const [group, sub] = args;
  if (group === "api") {
    return ghApiReason(args.slice(1));
  }
  const subs = group === undefined ? undefined : GH_READ[group];
  if (!subs || (subs.length && !subs.includes(sub ?? ""))) {
    return blocked(`\`gh ${args.slice(0, 2).join(" ")}\``);
  }
  return undefined;
}

function overbridgeReason(args: readonly string[]): string | undefined {
  const [sub, action] = args;
  const actions = sub === undefined ? undefined : OVERBRIDGE_ALLOWED[sub];
  if (!actions || (actions.length && !actions.includes(action ?? ""))) {
    return blocked(`\`overbridge ${args.slice(0, 2).join(" ")}\``.trim());
  }
  return undefined;
}

function segmentReason(words: readonly string[]): string | undefined {
  // leading `VAR=value` words only set the environment of the command after them
  const at = words.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  if (at < 0) {
    return undefined;
  }
  const cmd = basename(words[at]!);
  const args = words.slice(at + 1);
  if (cmd === "git") {
    return gitReason(args);
  }
  if (cmd === "gh") {
    return ghReason(args);
  }
  if (cmd === "gs") {
    return ghReason(["stack", ...args]);
  }
  if (cmd === "overbridge" || cmd === "ws") {
    return overbridgeReason(args);
  }
  const flags = READ_UTILS[cmd];
  if (!flags) {
    return blocked(`\`${cmd}\``);
  }
  const bad = args.find((a) => flags.some((f) => a === f || a.startsWith(`${f}=`)));
  return bad ? blocked(`\`${cmd} ${bad}\``) : undefined;
}

/** Returns a reason to block the orchestrator's tool call, or undefined to allow it. */
export function checkOrchestrator(input: HookInput): string | undefined {
  const tool = input.tool_name ?? "";
  if (tool === "Bash") {
    const split = splitCommand(String(input.tool_input?.command ?? ""));
    if ("reason" in split) {
      return split.reason;
    }
    return split.segments.map(segmentReason).find((r) => r !== undefined);
  }
  if (ALLOWED_TOOLS.has(tool) || MCP_READ.test(tool)) {
    return undefined;
  }
  return blocked(`the ${tool || "unnamed"} tool`);
}
