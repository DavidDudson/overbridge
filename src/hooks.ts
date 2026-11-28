import { root, selfCommand, worktreePath } from "./paths";
import { itemIdOf } from "./pm";
import { type HookName, loadRepoConfig, type ProjectConfig } from "./project-config";
import { errorMessage, log } from "./util";

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
  return runHooksReport(name, ctx).ok;
}

/** How many trailing characters of a failed hook's output go into the failure report. */
const OUTPUT_TAIL = 400;

export interface HookReport {
  ok: boolean;
  /** The failed hook's command and the tail of its stderr; empty when every hook passed. */
  detail: string;
}

/** `runHooks` that also says what the failing hook printed, so a removal can show why it was refused. */
export function runHooksReport(name: HookName, ctx: HookContext): HookReport {
  const dir = worktreePath(ctx.ws, ctx.repo);
  let config: ProjectConfig;

  try {
    config = loadRepoConfig(dir, ctx.repo);
  } catch (e) {
    log(`${name} hooks skipped for ${ctx.ws}/${ctx.repo}: ${errorMessage(e)}`);

    return { ok: true, detail: "" };
  }

  const commands = config.hooks?.[name] ?? [];

  const env = {
    ...process.env,
    OVERBRIDGE_HOOK: name,
    OVERBRIDGE_ROOT: root(),
    OVERBRIDGE_SELF: selfCommand().join(" "),
    OVERBRIDGE_NAME: ctx.ws,
    OVERBRIDGE_REPO: ctx.repo,
    OVERBRIDGE_BRANCH: ctx.branch ?? "",
    OVERBRIDGE_PR: ctx.pr === undefined ? "" : String(ctx.pr),
    OVERBRIDGE_ITEM: itemIdOf(config.projectManagement, dir, ctx.branch),
  };

  for (const command of commands) {
    log(`${name} (${ctx.ws}/${ctx.repo}): ${command}`);
    const p = Bun.spawnSync({ cmd: ["sh", "-c", `exec 1>&2\n${command}`], cwd: dir, env, stdin: "ignore", stdout: "inherit", stderr: "pipe" });
    const stderr = p.stderr.toString();
    process.stderr.write(stderr);

    if (p.exitCode !== 0) {
      log(`${name} hook failed with exit code ${p.exitCode ?? "?"}: ${command}`);

      return { ok: false, detail: `${command.split("\n")[0]}: ${stderr.trim().slice(-OUTPUT_TAIL)}` };
    }
  }

  return { ok: true, detail: "" };
}
