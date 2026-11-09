import { root, selfCommand, worktreePath } from "./paths";
import { type HookName, loadRepoConfig } from "./project-config";
import { log } from "./util";

/** What a hook is told about the worktree it runs in. */
export interface HookContext {
  ws: string;
  repo: string;
  branch?: string;
  pr?: number;
}

/**
 * Run the root config's `hooks.<name>` commands for `ctx.repo`, in its worktree. Each runs with `sh -c`,
 * its stdout sent to stderr so it can't mix with a command's own output. Stops at the first failure and
 * returns false; true when every hook passed or there were none. A config that can't be read skips the
 * hooks with a warning.
 */
export function runHooks(name: HookName, ctx: HookContext): boolean {
  const dir = worktreePath(ctx.ws, ctx.repo);
  let commands: string[];
  try {
    commands = loadRepoConfig(dir, ctx.repo).hooks?.[name] ?? [];
  } catch (e) {
    log(`${name} hooks skipped for ${ctx.ws}/${ctx.repo}: ${(e as Error).message}`);
    return true;
  }
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    OVERBRIDGE_HOOK: name,
    OVERBRIDGE_ROOT: root(),
    OVERBRIDGE_SELF: selfCommand().join(" "),
    OVERBRIDGE_NAME: ctx.ws,
    OVERBRIDGE_REPO: ctx.repo,
    OVERBRIDGE_BRANCH: ctx.branch ?? "",
    OVERBRIDGE_PR: ctx.pr === undefined ? "" : String(ctx.pr),
  };
  for (const command of commands) {
    log(`${name} (${ctx.ws}/${ctx.repo}): ${command}`);
    const p = Bun.spawnSync({ cmd: ["sh", "-c", `exec 1>&2\n${command}`], cwd: dir, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    if (p.exitCode !== 0) {
      log(`${name} hook failed with exit code ${p.exitCode ?? "?"}: ${command}`);
      return false;
    }
  }
  return true;
}
