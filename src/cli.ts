#!/usr/bin/env bun
import { parseArgs } from "node:util";
import * as cmd from "./commands";
import { guardMain } from "./guard";
import { WsError } from "./util";

const HELP = `ws — multi-repo workspaces with bound Claude sessions in zellij

Setup
  ws init                               create ~/workspaces (or $WS_ROOT)
  ws repo add <name> <url> [--branch b] register + bare-clone a repo
  ws repo ls                            list registered repos
  ws sync                               fetch every bare repo

Workspaces
  ws new [name] [-r repo]...            create a workspace (default name wsN)
  ws add <repo> [--ws name]             add a repo worktree to a workspace
  ws rm <name> [--force]                remove a workspace and its worktrees
  ws status [--all] [--json]            claims, heads, gh-stack position, dirty state
  ws whoami                             workspace for the current dir/session

Branches & PRs (workspace inferred from $WS_NAME or cwd)
  ws checkout [repo] <branch|#pr|url>   claim + switch (adds repo if missing);
                                        a stacked PR pulls its whole stack via gh stack
  ws release [repo]                     drop claim, detach worktree in place
  ws pr [repo]                          record the open PR; claim follows HEAD within a stack

Zellij
  ws spinup [-p pages]                  ensure N full pages (4 ws each) exist, rebuild session
  ws up [--fresh]                       attach/launch session, 4 workspaces per tab
  ws layout                             print the generated zellij layout
  ws claude <name> [-- args]            run Claude bound to a workspace

Hooks
  ws guard                              Claude PreToolUse hook (reads JSON on stdin)
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
        if (positionals.length !== 2) throw new WsError("usage: ws repo add <name> <url> [--branch b]");
        cmd.repoAdd(positionals[0]!, positionals[1]!, values.branch);
      } else if (action === "ls" || action === "list") cmd.repoList();
      else throw new WsError("usage: ws repo add|ls");
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
      if (positionals.length < 1) throw new WsError("usage: ws add <repo>... [--ws name]");
      for (const r of positionals) cmd.addRepo(r, values.ws);
      break;
    }
    case "rm": {
      const { values, positionals } = opts(rest, { force: { type: "boolean", short: "f" } });
      if (positionals.length !== 1) throw new WsError("usage: ws rm <name> [--force]");
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
      const { values } = opts(rest, { pages: { type: "string", short: "p" } });
      cmd.spinup(Number(values.pages ?? 1));
      break;
    }
    case "layout":
      cmd.layout();
      break;
    case "claude": {
      const [name, ...extra] = rest;
      if (!name) throw new WsError("usage: ws claude <name> [-- claude args]");
      cmd.claude(name, extra[0] === "--" ? extra.slice(1) : extra);
      break;
    }
    case "guard":
      return guardMain();
    case undefined:
    case "help":
    case "-h":
    case "--help":
      console.log(HELP);
      break;
    default:
      throw new WsError(`unknown command '${sub}'\n\n${HELP}`);
  }
  return 0;
}

try {
  process.exit(await main(Bun.argv.slice(2)));
} catch (e) {
  if (e instanceof WsError || (e as any)?.code?.startsWith?.("ERR_PARSE_ARGS")) {
    console.error(`ws: ${(e as Error).message}`);
    process.exit(1);
  }
  throw e;
}
