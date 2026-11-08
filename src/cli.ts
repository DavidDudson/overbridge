#!/usr/bin/env bun
import { parseArgs } from "node:util";
import * as cmd from "./commands";
import { appCommand } from "./app-command";
import { guardMain } from "./guard";
import { DEFAULT_SPINUP } from "./layout";
import { item } from "./item";
import { sidebar } from "./sidebar";
import { topPanel, topRefresh } from "./top-run";
import { silenceLegacyWarnings } from "./paths";
import { OverbridgeError } from "./util";

const HELP = `overbridge (alias: ws) — multi-repo workspaces with bound Claude sessions in zellij

Setup
  overbridge init                               create ~/workspaces (or $OVERBRIDGE_ROOT)
  overbridge repo add <name> <url> [--branch b] register + bare-clone a repo
  overbridge repo ls                            list registered repos
  overbridge config check|show [path]           validate / print a repo's overbridge.yml
  overbridge config get <key> [path]            print one value, e.g. commands.test
  overbridge app [id [action]]                  list or start|stop|restart|status|log repo apps
  overbridge sync                               fetch every bare repo
  overbridge sidebar [--ws name]                tab sidebar pane (run by the generated layout)
  overbridge top [refresh] [--ws name]          top panel (links, editor, app toggles); refresh updates its cache

Work items (the repo's project-management provider)
  overbridge item view|from-branch|branch|assigned|create|edit   see 'overbridge item' for flags

Workspaces
  overbridge new [name] [-r repo]...            create a workspace (default name wsN)
  overbridge add <repo> [--ws name]             add a repo worktree to a workspace
  overbridge rm <name> [--force]                remove a workspace and its worktrees
  overbridge status [--all] [--json]            claims, heads, gh-stack position, dirty state
  overbridge whoami                             workspace for the current dir/session

Branches & PRs (workspace inferred from $OVERBRIDGE_NAME or cwd)
  overbridge checkout [repo] <branch|#pr|url>   claim + switch (adds repo if missing);
                                        a stacked PR pulls its whole stack via gh stack
  overbridge release [repo]                     drop claim, detach worktree in place
  overbridge pr [repo]                          record the open PR; claim follows HEAD within a stack

Zellij
  overbridge spinup [-n count]                  ensure N workspaces exist (default 4), rebuild session
  overbridge up [--fresh]                       attach/launch session, one tab per workspace
  overbridge layout                             print the generated zellij layout
  overbridge claude <name> [-- args]            run Claude bound to a workspace

Hooks
  overbridge guard                              Claude PreToolUse hook (reads JSON on stdin)
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
    case "spinup": {
      const { values } = opts(rest, { count: { type: "string", short: "n" } });
      cmd.spinup(Number(values.count ?? DEFAULT_SPINUP));
      break;
    }
    case "layout":
      cmd.layout();
      break;
    case "claude": {
      const [name, ...extra] = rest;
      if (!name) throw new OverbridgeError("usage: overbridge claude <name> [-- claude args]");
      cmd.claude(name, extra[0] === "--" ? extra.slice(1) : extra);
      break;
    }
    case "guard":
      silenceLegacyWarnings();
      return guardMain();
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      break;
    default:
      throw new OverbridgeError(`unknown command '${sub}'\n\n${HELP}`);
  }
  return 0;
}

try {
  process.exit(await main(Bun.argv.slice(2)));
} catch (e) {
  if (e instanceof OverbridgeError || (e as any)?.code?.startsWith?.("ERR_PARSE_ARGS")) {
    console.error(`overbridge: ${(e as Error).message}`);
    process.exit(1);
  }
  throw e;
}
