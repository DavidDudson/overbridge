/**
 * Claude Code PreToolUse hook. Installed into every workspace's
 * .claude/settings.json; keeps a workspace Claude inside its workspace and
 * routes branch changes through `ws checkout` so claims stay authoritative.
 *
 * Exit 2 blocks the tool call and shows stderr to Claude.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { currentWorkspace, isInside, root } from "./paths";

export type HookInput = { cwd?: string; tool_name?: string; tool_input?: Record<string, unknown> };
export type GuardCtx = { root: string; ws: string; home: string };

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

const BASH_RULES: [RegExp, string][] = [
  [new RegExp(GIT + String.raw`switch\b`), "branch changes go through `ws checkout <repo> <branch|#pr>`, not `git switch`"],
  [
    new RegExp(GIT + String.raw`checkout\b` + END),
    "branch changes go through `ws checkout <repo> <branch|#pr>`; to discard file changes use `git restore <path>` or `git checkout -- <path>`",
  ],
  [/\bgh\s+pr\s+checkout\b/, "use `ws checkout <repo> #<number>` so the PR is claimed for this workspace"],
  [
    new RegExp(GH_STACK + String.raw`checkout\b`),
    "use `ws checkout <repo> #<pr>`; it claims the whole stack and runs `gh stack checkout` for stacked PRs",
  ],
  [
    new RegExp(GH_STACK + String.raw`trunk\b`),
    "the trunk is shared across workspaces; stay on stack layers (`gh stack bottom`) or `ws release <repo>`",
  ],
  [new RegExp(GIT + String.raw`worktree\b`), "worktrees are managed by ws; ask the user"],
  [new RegExp(CMD + String.raw`ws\s+(?:new|rm|up|claude|init|layout|spinup)\b`),"workspace admin commands are for the user, not a workspace Claude"],
];

// Absolute, home-relative or parent-relative path tokens in a shell command.
const PATH_TOKEN = /(?:^|[\s=:'"(<>])((?:~|\.\.|\/)[^\s'";|&()<>]*)/g;

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}

/** Returns a reason to block the call, or undefined to allow it. */
export function check(input: HookInput, ctx: GuardCtx): string | undefined {
  const rootPath = real(ctx.root);
  const wsPath = real(join(ctx.root, ctx.ws));
  const cwd = input.cwd ?? wsPath;
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};

  const expand = (p: string) =>
    real(resolve(cwd, p === "~" || p.startsWith("~/") ? join(ctx.home, p.slice(1)) : p));
  const foreign = (abs: string) => isInside(abs, rootPath) && !isInside(abs, wsPath);

  if (WRITE_TOOLS.has(tool) || READ_TOOLS.has(tool)) {
    const paths = PATH_KEYS.map((k) => ti[k]).filter((v): v is string => typeof v === "string" && v !== "");
    if (tool === "Glob" && typeof ti.pattern === "string" && /^[~/]/.test(ti.pattern)) paths.push(ti.pattern);
    for (const p of paths) {
      const abs = expand(p);
      if (WRITE_TOOLS.has(tool)) {
        if (!isInside(abs, wsPath)) return `${tool} on ${abs} is outside workspace ${ctx.ws} (${wsPath})`;
        if (isInside(abs, join(wsPath, ".claude"))) return "workspace .claude config is managed by ws";
      } else if (foreign(abs)) {
        return `${abs} is outside workspace ${ctx.ws}; only ${wsPath} is accessible`;
      }
    }
    return;
  }

  if (tool === "Bash") {
    const cmd = String(ti.command ?? "").replace(/\$\{?HOME\}?/g, ctx.home);
    for (const [re, reason] of BASH_RULES) if (re.test(cmd)) return reason;
    const other = /--ws[=\s]+(\S+)/.exec(cmd);
    if (other && other[1] !== ctx.ws) return `workspace ${ctx.ws} cannot act on workspace ${other[1]}`;
    for (const m of cmd.matchAll(PATH_TOKEN)) {
      const abs = expand(m[1]!);
      if (foreign(abs)) return `${abs} is outside workspace ${ctx.ws}; only ${wsPath} is accessible`;
    }
  }
}

export async function guardMain(): Promise<number> {
  try {
    const input: HookInput = JSON.parse(await Bun.stdin.text());
    const ws = currentWorkspace(input.cwd ?? process.cwd());
    if (!ws) return 0;
    const reason = check(input, { root: root(), ws, home: homedir() });
    if (!reason) return 0;
    console.error(`ws guard: ${reason}`);
    return 2;
  } catch (e) {
    console.error(`ws guard: internal error, blocking to be safe: ${e}`);
    return 2;
  }
}
