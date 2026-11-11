import { parseArgs } from "node:util";
import * as cmd from "./commands";
import { REQUIRED_SKILLS, requiredSkillProblems } from "./plugins";
import { appCommand } from "./app-command";
import { guardMain } from "./guard";
import { cleanup, Fetch, Format } from "./cleanup-gather";
import { extCommand } from "./ext";
import { icebox, thaw } from "./icebox";
import { item } from "./item";
import { go, GO_USAGE } from "./go";
import { historyStore } from "./history";
import { summaries, summaryLines } from "./history-report";
import { next } from "./next";
import { diff } from "./panes";
import { orchestrationTab } from "./orchestration";
import { currentTab, sidebar } from "./sidebar";
import { FINISH_FLAG, finishRemoval } from "./remove";
import { sweepWithServer } from "./merge-sweep";
import { showTab, start, startStack, startTask } from "./start";
import { perfPane } from "./perf-run";
import { topPanel, topRefresh } from "./top-run";
import { prListPane, refreshPrList, type PrListKind } from "./prlist-run";
import { readWorklist, refreshWorklist, showWorklist, worklistPane } from "./worklist-run";
import { silenceLegacyWarnings } from "./paths";
import { externalCommand, externalEnv, externalHelp } from "./external";
import { exec, log, OverbridgeError } from "./util";

const START_USAGE =
  "usage: overbridge start <repo> <id> [--prompt text] [--here] | overbridge start <repo> --stack <id1> <id2>... [--name slug] [--prompt text] | overbridge start <repo> --task <slug> --prompt <text>";

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
  overbridge go <n>|<name>|next|prev            switch tab by sidebar number, name, or neighbour (wrapping);
                                        works outside zellij too, so a window-manager key can call it
  overbridge diff [--ws name]                   changes since the default branch, whitespace ignored, via delta
  overbridge sync                            fetch every bare repo
  overbridge sidebar [--ws name|@tab]           tab sidebar pane (run by the generated layout)
  overbridge serve                              the one long-running process that owns network refreshes and the shared
                                        cache; panels and hooks start it on demand, it exits when idle, and each
                                        refresh falls back to a child process when it is down
  overbridge top [refresh] [--ws name]          top panel (links, editor, app toggles); refresh updates its cache
  overbridge top sweep                          remove every workspace whose PRs have all merged (sidebars run it every minute)
  overbridge worklist [refresh|show]            work list pane (the @work tab); refresh reads every board into its cache; show prints it
  overbridge prs [refresh]                      PRs you opened (the @prs tab); reviews [refresh]: PRs waiting for your review (@reviews)
  overbridge perf                               performance pane (the @perf tab): the history per workspace
  overbridge history [--ws name] [--hours n] [--json]   where time went: Claude turns, tools, waiting, checks

Work items (the repo's project-management provider)
  overbridge item view|from-branch|branch|assigned|create|edit   see 'overbridge item' for flags

Skill extensions
  overbridge ext <skill> <phase>                extra instructions for a skill phase, from skill-extensions
                                        dirs and the repo's .overbridge/ext (prints nothing when none)
  overbridge ext list                           every extension file found

Workspaces
  overbridge start <repo> <id> [--prompt text]  workspace named for a work item (ENG-123, gh-app-12), on its
                                        branch, in a new tab running /start-item; focuses an existing one's
                                        tab, or opens it when it has none. Inside a workspace on a task/
                                        branch with no PR, re-binds that workspace to the item instead
                                        (the item's branch is claimed in place, carrying the task's work)
  overbridge start <repo> <id> --here           re-bind the current workspace to the item from any clean claim
  overbridge start <repo> --task <slug> --prompt <text>
                                        work with no item yet (a ticket to file, a spike): workspace <slug>
                                        on branch task/<slug>, in a new tab whose Claude starts with <text>
  overbridge start <repo> --stack <id1> <id2>... [--name slug] [--prompt text]
                                        items in dependency order, bottom first: one workspace (<slug>, else
                                        the first item's name plus -stack) holding a gh stack with one layer
                                        (branch + claim) per item, on layer 1, in a new tab running /start-item
  overbridge new <name> [-r repo]...            create a workspace and open its tab
  overbridge tab <name> [--prompt text]         open a workspace's tab when it has none, else focus it
  overbridge add <repo> [--ws name]             add a repo worktree to a workspace
  overbridge shell <repo> [--ws name] -- <cmd>  run a command in the repo's dev shell (its shell key in
                                        overbridge.yml); as it is when the repo has none
  overbridge check [repo] [--ws name] [--timeout-seconds n] -- <cmd>
                                        run a heavy command (lint, typecheck, test, build) in the repo's
                                        dev shell, queued across workspaces, several at once while the load allows;
                                        killed on timeout or when it stops using CPU (check-queue in overbridge.yml)
  overbridge rm <name> [--force]              remove a workspace and its worktrees (the top panel's
                                        Cleanup button does this once the PR is open and nothing is unpushed);
                                        also removes an orphan: a workspace folder that status does not list
  overbridge cleanup [--json] [--no-fetch]      report what each workspace and orphan folder is fit for: remove,
                                        review (unsaved work), rebind, ask or keep. Removes nothing; --dry-run
                                        is accepted and changes nothing (the cleanup skill acts on the report)
  overbridge icebox <name> [--prune] [--drop-worktree]
                                        pause a workspace: stop its apps and checks, write a handoff, close
                                        its tab; keeps claims; refuses with unsaved work. --prune deletes the
                                        repo's icebox.prune paths (never tracked files); --drop-worktree removes
                                        the worktrees, keeping the branches. Nothing is reclaimed without a flag
  overbridge thaw <name>                        reopen an iceboxed workspace's tab, its agent resuming and
                                        reading the handoff; recreates dropped worktrees on their branches
  overbridge status [--all] [--json]            claims, heads, gh-stack position, dirty and iceboxed state
  overbridge whoami                             workspace for the current dir/session
  overbridge prereqs                            exit 1 unless the skills overbridge's skills depend on (gh-stack)
                                        are installed

Branches & PRs (workspace inferred from $OVERBRIDGE_NAME or cwd)
  overbridge checkout [repo] <branch|#pr|url>   claim + switch (adds repo if missing);
                                        a stacked PR pulls its whole stack via gh stack
  overbridge release [repo]                     drop claim, detach worktree in place
  overbridge pr [repo]                          record the open PR; claim follows HEAD within a stack

Zellij
  overbridge spinup                             rebuild the session (creates an empty 'scratch' workspace if none)
  overbridge up [--fresh]                       attach/launch session: the orchestration tabs (@root: Claude in
                                        the root, guarded to coordinate only), then one tab per workspace
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
    case "go": {
      const { positionals } = opts(rest, {});
      if (positionals.length !== 1) throw new OverbridgeError(GO_USAGE);
      console.log(go(positionals[0]!));
      break;
    }
    case "diff": {
      const { values } = opts(rest, ws);
      diff(cmd.requireWs(values.ws));
      break;
    }
    case "history": {
      const { values } = opts(rest, { ...ws, hours: { type: "string" }, json: { type: "boolean" } });
      const hours = values.hours === undefined ? undefined : Number(values.hours);
      if (hours !== undefined && !(hours > 0)) throw new OverbridgeError("usage: overbridge history [--ws name] [--hours n] [--json]");
      if (values.ws && !historyStore().workspaces().includes(values.ws)) throw new OverbridgeError(`no history for ${values.ws}`);
      const rows = summaries(undefined, hours === undefined ? undefined : hours * 3600_000, values.ws);
      if (values.json) console.log(JSON.stringify(rows, null, 2));
      else if (!rows.length) log("no history yet");
      else for (const row of rows) console.log(summaryLines(row).join("\n"));
      break;
    }
    case "perf":
      await perfPane();
      break;
    case "worklist": {
      const sub = rest[0];
      if (sub === "refresh") {
        const cache = refreshWorklist();
        log(`worklist: ${cache.rows.length} open item(s)${cache.notes.length ? `; ${cache.notes.join("; ")}` : ""}`);
      } else if (sub === "show") {
        console.log(showWorklist(readWorklist()).join("\n"));
      } else if (sub !== undefined) {
        throw new OverbridgeError("usage: overbridge worklist [refresh|show]");
      } else {
        await worklistPane();
      }
      break;
    }
    case "prs":
    case "reviews": {
      const kind: PrListKind = sub;
      if (rest[0] === "refresh") {
        const cache = refreshPrList(kind);
        log(`${kind}: ${cache.rows.length} open PR(s)${cache.error ? `; ${cache.error}` : ""}`);
      } else if (rest[0] !== undefined) {
        throw new OverbridgeError(`usage: overbridge ${kind} [refresh]`);
      } else {
        await prListPane(kind);
      }
      break;
    }
    case "top": {
      const { values, positionals } = opts(rest, ws);
      if (positionals[0] === "refresh") topRefresh(values.ws);
      else if (positionals[0] === "sweep") await sweepWithServer();
      else if (positionals.length) throw new OverbridgeError("usage: overbridge top [refresh|sweep] [--ws name]");
      else await topPanel(values.ws);
      break;
    }
    case "serve": {
      opts(rest, {});
      const { serve } = await import("./server");
      await serve();
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
      const { values, positionals } = opts(rest, { force: { type: "boolean", short: "f" }, [FINISH_FLAG]: { type: "boolean" } });
      if (positionals.length !== 1) throw new OverbridgeError("usage: overbridge rm <name> [--force]");
      if (values[FINISH_FLAG]) {
        await finishRemoval(positionals[0]!);
      } else {
        cmd.removeWorkspace(positionals[0]!, !!values.force);
      }
      break;
    }
    case "cleanup": {
      const { values, positionals } = opts(rest, { json: { type: "boolean" }, "no-fetch": { type: "boolean" }, "dry-run": { type: "boolean" } });
      if (positionals.length) throw new OverbridgeError("usage: overbridge cleanup [--json] [--no-fetch]");
      cleanup(values.json ? Format.Json : Format.Table, values["no-fetch"] ? Fetch.No : Fetch.Yes);
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
    case "prereqs": {
      const problems = requiredSkillProblems();
      if (problems.length) throw new OverbridgeError(problems.join("\n"));
      console.log(`ok: ${REQUIRED_SKILLS.join(", ")} installed`);
      break;
    }
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
    case "tab": {
      const { values, positionals } = opts(rest, { prompt: { type: "string" } });
      if (positionals.length !== 1) throw new OverbridgeError("usage: overbridge tab <name> [--prompt text]");
      showTab(cmd.requireWs(positionals[0]!), { prompt: values.prompt });
      break;
    }
    case "icebox": {
      const { values, positionals } = opts(rest, { prune: { type: "boolean" }, "drop-worktree": { type: "boolean" } });
      if (positionals.length !== 1) throw new OverbridgeError("usage: overbridge icebox <name> [--prune] [--drop-worktree]");
      const handoff = await icebox(cmd.requireWs(positionals[0]!), { prune: values.prune, dropWorktree: values["drop-worktree"] });
      console.log(`iceboxed ${positionals[0]}; handoff at ${handoff}`);
      break;
    }
    case "thaw": {
      const { positionals } = opts(rest, {});
      if (positionals.length !== 1) throw new OverbridgeError("usage: overbridge thaw <name>");
      thaw(cmd.requireWs(positionals[0]!));
      break;
    }
    case "start": {
      const { values, positionals } = opts(rest, {
        prompt: { type: "string" },
        task: { type: "string" },
        stack: { type: "boolean" },
        name: { type: "string" },
        here: { type: "boolean" },
      });
      if (values.stack) {
        if (values.task !== undefined || values.here || positionals.length < 3) throw new OverbridgeError(START_USAGE);
        startStack(positionals[0]!, positionals.slice(1), { name: values.name, prompt: values.prompt });
        break;
      }
      if (values.name !== undefined) throw new OverbridgeError("--name only goes with --stack");
      if (values.task !== undefined) {
        if (positionals.length !== 1 || values.prompt === undefined || values.here) {
          throw new OverbridgeError("usage: overbridge start <repo> --task <slug> --prompt <text>");
        }
        startTask(positionals[0]!, values.task, values.prompt);
        break;
      }
      if (positionals.length !== 2) throw new OverbridgeError(START_USAGE);
      start(positionals[0]!, positionals[1]!, values.prompt, { here: values.here });
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
      if (tab?.pane) throw new OverbridgeError(`${tab.tab} runs \`overbridge ${tab.pane}\`, not Claude`);
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
