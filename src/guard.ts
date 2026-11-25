/**
 * Claude Code PreToolUse hook. Installed into every workspace's
 * .claude/settings.json; keeps a workspace Claude inside its workspace and
 * routes branch changes through `overbridge checkout` so claims stay authoritative.
 * An orchestration tab's Claude gets the stricter `checkOrchestrator` (guard-orchestrator.ts) instead.
 *
 * Exit 2 blocks the tool call and shows stderr to Claude. Under agy (`guard --agy`) the payload is translated
 * from agy's shape first; a deny is agy's JSON decision on stdout and an allow prints nothing.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agyToolDecision, fromAgy, UNREADABLE_TOOL } from "./agy-hook";
import { recordHook } from "./agent-hook";
import { AgentKind } from "./agent-kind";
import { checkOrchestrator } from "./guard-orchestrator";
import { isJsonString, type JsonObject, stringField } from "./json";
import { currentWorkspace, isInside, ORCHESTRATION_ENV, realPath, root } from "./paths";
import { type GuardConfig, loadRootLayers } from "./project-config";

export type HookInput = { cwd?: string; tool_name?: string; tool_input?: JsonObject };

/** `extra` is the root config's `guard` block: more paths to read and more commands to block. */
export type GuardCtx = { root: string; ws: string; home: string; extra?: GuardConfig; agent?: AgentKind };

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const PATH_KEYS = ["file_path", "path", "notebook_path"];

// `git`, optionally followed by global options like `-C dir` or `--no-pager`.
const GIT = String.raw`\bgit(?:\s+(?:-[cC]\s+\S+|--?[\w.-]+(?:=\S+)?))*\s+`;

// Command position: start of line, or after a separator, subshell or backtick; optional path prefix.
const CMD = String.raw`(?:^|[;&|(\x60\n])\s*(?:\S*/)?`;

// `gh stack`, or its default `gs` shell alias in command position.
const GH_STACK = CMD + String.raw`(?:gh\s+stack|gs)\s+`;
const END =String.raw`(?![^;&|\n]*\s--(?:\s|$))`; // no ` -- ` (pathspec) later in the same command

/** Shell rules for agy workspaces only. Best effort: the guard's own config lives in `.agents/hooks.json`, which every launch rewrites. */
const AGY_BASH_RULES: [RegExp, string][] = [
  [/\.agents\b[\s\S]*\b(?:hooks|skills)\.json\b|\b(?:hooks|skills)\.json\b[\s\S]*\.agents\b|\bcd\s+\S*\.agents\b/, "workspace .agents config is managed by overbridge"],
  [
    new RegExp(CMD + String.raw`(?:rm|rmdir|mv|cp|ln|chmod|chown|touch|truncate|tee|install|sed\s+-i|perl\s+-p?i)\b[^;&|\n]*(?:^|[\s/'"=])\.agents\b|>\s*['"]?\S*\.agents\b`),
    "workspace .agents config is managed by overbridge",
  ],
];

const BASH_RULES: [RegExp, string][] = [
  [new RegExp(GIT + String.raw`switch\b`), "branch changes go through `overbridge checkout <repo> <branch|#pr>`, not `git switch`"],
  [
    new RegExp(GIT + String.raw`checkout\b` + END),
    "branch changes go through `overbridge checkout <repo> <branch|#pr>`; to discard file changes use `git restore <path>` or `git checkout -- <path>`",
  ],
  [/\bgh\s+pr\s+checkout\b/, "use `overbridge checkout <repo> #<number>` so the PR is claimed for this workspace"],
  [
    new RegExp(GH_STACK + String.raw`checkout\b`),
    "use `overbridge checkout <repo> #<pr>`; it claims the whole stack and runs `gh stack checkout` for stacked PRs",
  ],
  [
    new RegExp(GH_STACK + String.raw`trunk\b`),
    "the trunk is shared across workspaces; stay on stack layers (`gh stack bottom`) or `overbridge release <repo>`",
  ],
  [
    // Allow list: every other subcommand (unstack, modify, link, merge, switch...) rewrites or deletes stacks
    // across workspaces, or is interactive. Leading flags are skipped, so `-R x unstack` cannot hide the subcommand (a flag value then reads as an unknown word and blocks); a bare flag (`--version`, `--help`) passes; a quoted or expanded word (`"link"`, `$x`) is not a known subcommand, so it is blocked.
    new RegExp(GH_STACK + String.raw`(?:-\S*\s+)*(?!(?:init|add|up|down|top|bottom|push|submit|rebase|sync|view)\b)[^\s-]`),
    "only `gh stack init/add/up/down/top/bottom/push/submit/rebase/sync/view` are allowed here; ask the user to run other stack commands",
  ],
  [new RegExp(GIT + String.raw`worktree\b`), "worktrees are managed by overbridge; ask the user"],
  [new RegExp(CMD + String.raw`(?:overbridge|ws)\s+(?:new|rm|up|claude|send|init|layout|spinup|checks|config\s+set|mods\s+(?:install|update|rm))\b`),"workspace admin commands are for the user, not a workspace Claude"],
  [
    new RegExp(CMD + String.raw`(?:overbridge|ws)\s+relaunch\b[^;&|\n]*\s['"]?(?:--env\b|--['"]?(?:\s|$))`),
    "an agent can relaunch only with --no-code-mode and --chrome; --env and agent arguments are for the user",
  ],
];

// Absolute, home-relative or parent-relative path tokens in a shell command.
const PATH_TOKEN = /(?:^|[\s=:'"(<>])((?:~|\.\.|\/)[^\s'";|&()<>]*)/g;

/** Returns a reason to block the call, or undefined to allow it. */
export function check(input: HookInput, ctx: GuardCtx): string | undefined {
  const rootPath = realPath(ctx.root);
  const wsPath = realPath(join(ctx.root, ctx.ws));
  const cwd = input.cwd ?? wsPath;
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};

  const expand = (p: string) =>
    realPath(resolve(cwd, p === "~" || p.startsWith("~/") ? join(ctx.home, p.slice(1)) : p));

  const readable = (ctx.extra?.readPaths ?? []).map(expand);

  // Under the root but outside this workspace. `read-paths` only ever relaxes reads, never writes.
  const foreign = (abs: string) =>
    isInside(abs, rootPath) && !isInside(abs, wsPath) && !readable.some((dir) => isInside(abs, dir));

  if (tool === UNREADABLE_TOOL) return stringField(ti, "reason") ?? "overbridge cannot read this agy tool call";

  if (WRITE_TOOLS.has(tool) || READ_TOOLS.has(tool)) {
    const listed = Array.isArray(ti.paths) ? ti.paths.filter(isJsonString) : [];

    const paths = [
      ...PATH_KEYS.flatMap((k) => {
        const value = stringField(ti, k);

        return value ? [value] : [];
      }),
      ...listed,
    ];

    const pattern = stringField(ti, "pattern");

    if (tool === "Glob" && pattern && /^[~/]/.test(pattern)) paths.push(pattern);

    for (const p of paths) {
      const abs = expand(p);

      if (WRITE_TOOLS.has(tool)) {
        if (!isInside(abs, wsPath)) return `${tool} on ${abs} is outside workspace ${ctx.ws} (${wsPath})`;

        if (isInside(abs, join(wsPath, ".claude"))) return "workspace .claude config is managed by overbridge";

        if (isInside(abs, join(wsPath, ".agents"))) return "workspace .agents config is managed by overbridge";
      } else if (foreign(abs)) {
        return `${abs} is outside workspace ${ctx.ws}; only ${wsPath} is accessible`;
      }
    }

    return;
  }

  if (tool === "Bash") {
    const cmd = String(ti.command ?? "").replace(/\$\{?HOME\}?/g, ctx.home);

    // the folder the command runs in, whole: the token scan below stops at a space in it
    if (foreign(expand(cwd))) return `${expand(cwd)} is outside workspace ${ctx.ws}; only ${wsPath} is accessible`;

    if (ctx.agent === AgentKind.Agy && isInside(expand(cwd), join(wsPath, ".agents"))) return "workspace .agents config is managed by overbridge";

    for (const [re, reason] of BASH_RULES) if (re.test(cmd)) return reason;

    if (ctx.agent === AgentKind.Agy) for (const [re, reason] of AGY_BASH_RULES) if (re.test(cmd)) return reason;

    for (const { pattern, reason } of ctx.extra?.deny ?? []) if (pattern.test(cmd)) return reason;
    const other = /--ws[=\s]+(\S+)/.exec(cmd);

    if (other && other[1] !== ctx.ws) return `workspace ${ctx.ws} cannot act on workspace ${other[1]}`;

    for (const m of cmd.matchAll(PATH_TOKEN)) {
      const abs = expand(m[1]!);

      if (foreign(abs)) return `${abs} is outside workspace ${ctx.ws}; only ${wsPath} is accessible`;
    }
  }
}

export async function guardMain(agent: AgentKind = AgentKind.Claude): Promise<number> {
  try {
    const raw = JSON.parse(await Bun.stdin.text());
    const input: HookInput = agent === AgentKind.Agy ? fromAgy(raw) : raw;
    const reason = guardReason(input, process.env, agent);
    const message = reason && `overbridge guard: ${reason}`;

    // agy takes one decision per hook entry, so its PreToolUse runs only the guard, which records the call too
    if (agent === AgentKind.Agy) await recordHook(input, AgentKind.Agy);

    return answer(agent, message);
  } catch (e) {
    return answer(agent, `overbridge guard: internal error, blocking to be safe: ${e}`);
  }
}

/** Block with `message`, or allow when there is none: exit 2 and stderr for Claude; for agy, exit 0 with its JSON deny on stdout, or nothing on stdout to allow. */
function answer(agent: AgentKind, message: string | undefined): number {
  if (agent === AgentKind.Agy) {
    const decision = agyToolDecision(message);

    if (decision) {
      console.log(decision);
    }

    return 0;
  }

  if (!message) return 0;
  console.error(message);

  return 2;
}

/**
 * Which guard applies: the orchestrator's when the call comes from an orchestration tab's Claude, which has
 * `OVERBRIDGE_TAB` set and no workspace name, wherever its cwd is; else the workspace guard, if the call is
 * inside a workspace.
 */
export function guardReason(input: HookInput, env: Record<string, string | undefined>, agent: AgentKind = AgentKind.Claude): string | undefined {
  if (env[ORCHESTRATION_ENV] && !env.OVERBRIDGE_NAME) {
    return checkOrchestrator(input);
  }

  const ws = currentWorkspace(input.cwd ?? process.cwd());

  if (!ws) {
    return undefined;
  }

  // a config.yml that can't be read throws, and guardMain's catch blocks: the guard fails closed
  return check(input, { root: root(), ws, home: homedir(), extra: loadRootLayers().guard, agent });
}
