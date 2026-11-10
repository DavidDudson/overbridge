import { parseArgs } from "node:util";
import * as cmd from "./commands";
import { appCommand } from "./app-command";
import { guardMain } from "./guard";
import { extCommand } from "./ext";
import { item } from "./item";
import { next } from "./next";
import { diff } from "./panes";
import { orchestrationTab } from "./orchestration";
import { currentTab, sidebar } from "./sidebar";
import { start } from "./start";
import { topPanel, topRefresh } from "./top-run";
import { silenceLegacyWarnings } from "./paths";
import { externalCommand, externalEnv, externalHelp } from "./external";
import { exec, OverbridgeError } from "./util";

const HELP = `overbridge (alias: ws) — multi-repo workspaces with bound Claude sessions in zellij

Setup
  overbridge init                               create ~/workspaces (or $OVERBRIDGE_ROOT)
  overbridge repo add <name> <url> [--branch b] register + bare-clone a repo
  overbridge repo ls                            list registered repos
  overbridge config check|show [path]           validate / print a repo's overbridge.yml
  overbridge config get <key> [path]            print one value, e.g. commands.test
  overbridge app [id [action]]                  list or start|stop|restart|status|log repo apps
  overbridge next                               go to the next tab needing you: waiting for input, then finished,
                                        then finished with background tasks (zellij binds it to a key)
  overbridge diff [--ws name]                   changes since the default branch, whitespace ignored, via delta
  overbridge sync                            fetch every bare repo
  overbridge sidebar [--ws name|@tab]           tab sidebar pane (run by the generated layout)
  overbridge top [refresh] [--ws name]          top panel (links, editor, app toggles); refresh updates its cache

Work items (the repo's project-management provider)
  overbridge item view|from-branch|branch|assigned|create|edit   see 'overbridge item' for flags

Skill extensions
  overbridge ext <skill> <phase>                extra instructions for a skill phase, from skill-extensions
                                        dirs and the repo's .overbridge/ext (prints nothing when none)
  overbridge ext list                           every extension file found

Workspaces
  overbridge start <repo> <id> [--prompt text]  workspace named for a work item (ENG-123, gh-app-12), on its
                                        branch, in a new tab running /start-item; focuses an existing one
  overbridge new <name> [-r repo]...            create a workspace
  overbridge add <repo> [--ws name]             add a repo worktree to a workspace
  overbridge shell <repo> [--ws name] -- <cmd>  run a command in the repo's dev shell (its shell key in
                                        overbridge.yml); as it is when the repo has none
  overbridge check [repo] [--ws name] [--timeout-seconds n] -- <cmd>
                                        run a heavy command (lint, typecheck, test, build) in the repo's
                                        dev shell, one at a time across workspaces, once the load allows;
                                        killed on timeout or when it stops using CPU (check-queue in overbridge.yml)
  overbridge rm <name> [--force]              remove a workspace and its worktrees (the top panel's
                                        Cleanup button does this once the PR is open and nothing is unpushed)
  overbridge status [--all] [--json]            claims, heads, gh-stack position, dirty state
  overbridge whoami                             workspace for the current dir/session

Branches & PRs (workspace inferred from $OVERBRIDGE_NAME or cwd)
  overbridge checkout [repo] <branch|#pr|url>   claim + switch (adds repo if missing);
                                        a stacked PR pulls its whole stack via gh stack
  overbridge release [repo]                     drop claim, detach worktree in place
  overbridge pr [repo]                          record the open PR; claim follows HEAD within a stack

Zellij
  overbridge spinup                             rebuild the session (creates an empty 'scratch' workspace if none)
  overbridge up [--fresh]                       attach/launch session: the orchestration tabs (@root: Claude in
                                        the root, no guard), then one tab per workspace
  overbridge layout                             print the generated zellij layout
  overbridge claude <name|@tab> [-- args]       run Claude bound to a workspace, or an orchestration tab's Claude

Hooks
  overbridge guard                              Claude PreToolUse hook (reads JSON on stdin)

Extending
  overbridge <name> [args]                      runs overbridge-<name> from PATH when <name> is not built in;
                                        it gets OVERBRIDGE_ROOT, OVERBRIDGE_SELF and OVERBRIDGE_NAME
`;

function opts<T extends Record<string, { type: "string" | "boolean"; short?: string; multiple?: boolean }>>(
  args: string[],
  options: T,
) {
  return parseArgs({ args, options, allowPositionals: true, strict: true });
}

async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const ws = { ws: { type: "string" as const } };
  switch (sub) {
    case "init":
      cmd.init();
      break;
    case "repo": {
      const [action, ...r] = rest;
      if (action === "add") {
        const { values, positionals } = opts(r, { branch: { type: "string" } });
        if (positionals.length !== 2) throw new OverbridgeError("usage: overbridge repo add <name> <url> [--branch b]");
        cmd.repoAdd(positionals[0]!, positionals[1]!, values.branch);
      } else if (action === "ls" || action === "list") cmd.repoList();
      else throw new OverbridgeError("usage: overbridge repo add|ls");
      break;
    }
    case "config": {
      const [action, target] = rest;
      if (action === "check") cmd.configCheck(target);
      else if (action === "show") cmd.configShow(target);
      else if (action === "get") {
        if (!target) throw new OverbridgeError("usage: overbridge config get <key> [path]");
        cmd.configGet(target, rest[2]);
      } else throw new OverbridgeError("usage: overbridge config check|show|get [path]");
      break;
    }
    case "item":
      item(rest);
      break;
    case "ext":
      extCommand(rest);
      break;
    case "app": {
      const { values, positionals } = opts(rest, { ...ws, repo: { type: "string" }, "no-wait": { type: "boolean" } });
      await appCommand(values.ws, values.repo, positionals[0], positionals[1], !!values["no-wait"]);
      break;
    }
    case "sidebar": {
      const { values } = opts(rest, ws);
      await sidebar(values.ws);
      break;
    }
    case "next":
      console.log(next(currentTab()));
      break;
    case "diff": {
      const { values } = opts(rest, ws);
      diff(cmd.requireWs(values.ws));
      break;
    }
    case "top": {
      const { values, positionals } = opts(rest, ws);
      if (positionals[0] === "refresh") topRefresh(values.ws);
      else if (positionals.length) throw new OverbridgeError("usage: overbridge top [refresh] [--ws name]");
      else await topPanel(values.ws);
      break;
    }
    case "sync":
      cmd.sync();
      break;
    case "new": {
      const { values, positionals } = opts(rest, { repo: { type: "string", short: "r", multiple: true } });
      cmd.newWorkspace(positionals[0], values.repo ?? []);
      break;
    }
    case "add": {
      const { values, positionals } = opts(rest, ws);
      if (positionals.length < 1) throw new OverbridgeError("usage: overbridge add <repo>... [--ws name]");
      for (const r of positionals) cmd.addRepo(r, values.ws);
      break;
    }
    case "rm": {
      const { values, positionals } = opts(rest, { force: { type: "boolean", short: "f" } });
      if (positionals.length !== 1) throw new OverbridgeError("usage: overbridge rm <name> [--force]");
      cmd.removeWorkspace(positionals[0]!, !!values.force);
      break;
    }
    case "status":
    case "st": {
      const { values } = opts(rest, { all: { type: "boolean", short: "a" }, json: { type: "boolean" } });
      cmd.status(!!values.all, !!values.json);
      break;
    }
    case "whoami":
      cmd.whoami();
      break;
    case "checkout":
    case "co": {
      const { values, positionals } = opts(rest, ws);
      cmd.checkout(positionals, values.ws);
      break;
    }
    case "release": {
      const { values, positionals } = opts(rest, ws);
      cmd.release(positionals[0], values.ws);
      break;
    }
    case "pr": {
      const { values, positionals } = opts(rest, ws);
      cmd.recordPr(positionals[0], values.ws);
      break;
    }
    case "up": {
      const { values } = opts(rest, { fresh: { type: "boolean" } });
      cmd.up(!!values.fresh);
      break;
    }
    case "spinup":
      opts(rest, {});
      cmd.spinup();
      break;
    case "start": {
      const { values, positionals } = opts(rest, { prompt: { type: "string" } });
      if (positionals.length !== 2) throw new OverbridgeError("usage: overbridge start <repo> <id> [--prompt text]");
      start(positionals[0]!, positionals[1]!, values.prompt);
      break;
    }
    case "layout":
      cmd.layout();
      break;
    case "claude": {
      const [name, ...extra] = rest;
      if (!name) throw new OverbridgeError("usage: overbridge claude <name> [-- claude args]");
      const args = extra[0] === "--" ? extra.slice(1) : extra;
      const tab = orchestrationTab(name);
      if (tab) cmd.claudeOrchestration(tab, args);
      else cmd.claude(name, args);
      break;
    }
    case "shell": {
      // everything after `--` belongs to the child: never parse its flags
      const cut = rest.indexOf("--");
      const mine = cut < 0 ? rest : rest.slice(0, cut);
      const { values, positionals } = opts(mine, ws);
      if (positionals.length !== 1 || cut < 0 || cut === rest.length - 1)
        throw new OverbridgeError("usage: overbridge shell <repo> [--ws name] -- <cmd>...");
      cmd.shell(positionals[0]!, rest.slice(cut + 1), values.ws);
      break;
    }
    case "check": {
      // everything after `--` belongs to the child: never parse its flags
      const cut = rest.indexOf("--");
      const usage = "usage: overbridge check [repo] [--ws name] [--timeout-seconds n] -- <cmd>...";
      const { values, positionals } = opts(cut < 0 ? rest : rest.slice(0, cut), { ...ws, "timeout-seconds": { type: "string" } });
      if (positionals.length > 1 || cut < 0 || cut === rest.length - 1) throw new OverbridgeError(usage);
      const timeout = values["timeout-seconds"];
      const timeoutSeconds = timeout === undefined ? undefined : Number(timeout);
      if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1))
        throw new OverbridgeError(`--timeout-seconds expects a whole number of seconds above 0 (got '${timeout}')\n${usage}`);
      return cmd.check(positionals[0], rest.slice(cut + 1), values.ws, timeoutSeconds);
    }
    case "guard":
      silenceLegacyWarnings();
      return guardMain();
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP + externalHelp());
      break;
    default: {
      const bin = externalCommand(sub);
      if (bin) return exec([bin, ...rest], { env: externalEnv() });
      throw new OverbridgeError(`unknown command '${sub}'\n\n${HELP}${externalHelp()}`);
    }
  }
  return 0;
}

/** Run the CLI with `argv` (without the interpreter and script) and exit. */
export async function run(argv: string[]): Promise<never> {
  try {
    process.exit(await main(argv));
  } catch (e) {
    if (e instanceof OverbridgeError || (e as any)?.code?.startsWith?.("ERR_PARSE_ARGS")) {
      console.error(`overbridge: ${(e as Error).message}`);
      process.exit(1);
    }
    throw e;
  }
}
