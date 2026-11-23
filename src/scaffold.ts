import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { agentDirOf } from "./layout";
import { excludeInRepo } from "./git";
import { ghReposCache, metaDir, ORCHESTRATION_ENV, orchestrationPlansDir, PLANS_DIR, root, selfCommand, worktreePath, wsDir } from "./paths";
import { pluginSettings } from "./plugins";
import { loadRepoConfig, rootMcpServers } from "./project-config";
import { agentOf, getWorkspace, readState } from "./state";
import { AgentKind } from "./agent-kind";
import { scaffoldAgy } from "./agy";
import { errorMessage, log, shellQuote } from "./util";

/**
 * Commands the overbridge skills run that auto mode's classifier otherwise blocks as unrequested writes to a
 * connected app. Merging a PR (`gh pr merge`, `gh stack merge`) stays gated: the user merges.
 */
export const ALLOWED_COMMANDS = [
  "Bash(overbridge:*)",
  "Bash(gh pr create:*)",
  "Bash(gh pr edit:*)",
  "Bash(gh pr ready:*)",
  ...["init", "add", "link", "push", "submit", "sync", "rebase"].map((sub) => `Bash(gh stack ${sub}:*)`),
];

/** Intent rules for the classifier: actions a command pattern cannot express. */
export const AUTO_MODE_ALLOW = [
  "Requesting a Copilot review on the user's own PR (POST requested_reviewers) is allowed.",
  "Replying to and resolving review threads left by automated reviewers (Copilot and other bots) on the user's own PR is allowed. Never resolve a human's thread.",
  "Force-pushing with --force-with-lease to a feature branch of the user's own open PR, including through gh stack push, is allowed. Never force-push the default branch or another person's branch, and never use bare --force.",
];

/**
 * (Re)write the files that bind a Claude session to workspace `ws`.
 * Idempotent; run on every launch so the hook path tracks the installed binary.
 */
export function scaffold(ws: string) {
  const dir = wsDir(ws);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const mcp = mcpServerSettings(ws);
  const settings = JSON.stringify(workspaceSettings(ws, mcp), null, 2) + "\n";
  writeFileSync(join(dir, ".claude", "settings.json"), settings);
  // a Claude started in a repo folder does not read the workspace's .claude, so it loads this copy with `--settings`
  mkdirSync(dirname(workspaceSettingsPath(ws)), { recursive: true });
  writeFileSync(workspaceSettingsPath(ws), settings);
  excludePlans(ws);
  const brief = claudeMd(ws, dir, devShellSection(ws));
  writeFileSync(join(dir, "CLAUDE.md"), brief);

  if (agentOf(readState().workspaces[ws]) === AgentKind.Agy) scaffoldAgy(ws, brief);
}

/** The copy of workspace `ws`'s settings kept in the meta dir, for a Claude whose cwd is a repo folder. */
export const workspaceSettingsPath = (ws: string) => join(metaDir(), "workspaces", `${ws}.settings.json`);

const workspaceSettings = (ws: string, mcp: McpServerSettings) => ({
  env: { OVERBRIDGE_NAME: ws, OVERBRIDGE_ROOT: root() },
  ...pluginSettings(),
  // relative, so plans land in the folder the agent starts in, which the guard lets it write
  plansDirectory: PLANS_DIR,
  permissions: { allow: ALLOWED_COMMANDS },
  autoMode: { allow: ["$defaults", ...AUTO_MODE_ALLOW] },
  hooks: agentStateHooks(),
  ...mcp,
});

/** Keep plans out of `git status` in every repo the agent could start in. */
function excludePlans(ws: string) {
  Object.keys(getWorkspace(readState(), ws).repos).forEach((repo) => {
    try {
      excludeInRepo(worktreePath(ws, repo), `/${PLANS_DIR}/`);
    } catch (e) {
      // the generated files must never block a launch
      log(`warning: ${errorMessage(e)}\n${repo}'s git status may list ${PLANS_DIR}`);
    }
  });
}

interface McpServerSettings {
  enabledMcpjsonServers?: string[];
}

/**
 * Claude honours `enabledMcpjsonServers` from `--settings` even in a folder it does not trust. Only the repo the
 * agent starts in counts, since that is the only `.mcp.json` Claude loads.
 */
function mcpServerSettings(ws: string): McpServerSettings {
  const agentDir = agentDirOf(ws);
  const repo = Object.keys(getWorkspace(readState(), ws).repos).find((r) => worktreePath(ws, r) === agentDir);

  if (!repo) {
    return {};
  }

  try {
    const servers = rootMcpServers(repo);

    return servers.length ? { enabledMcpjsonServers: servers } : {};
  } catch (e) {
    // the generated files must never block a launch
    log(`warning: ${errorMessage(e)}\nClaude will ask before starting ${repo}'s .mcp.json servers`);

    return {};
  }
}

const hook = (sub: string) => ({ type: "command", command: [...selfCommand(), sub].map(shellQuote).join(" ") });

/**
 * The hooks every Claude gets: the guard, and the recorder of what the agent is doing (the sidebar glyphs, and
 * the history of where its time goes): see agent-hook.ts and history.ts.
 */
function agentStateHooks() {
  const state = [{ hooks: [hook("hook")] }];

  return {
    PreToolUse: [{ matcher: "*", hooks: [hook("guard"), hook("hook")] }],
    ...Object.fromEntries(["SessionStart", "UserPromptSubmit", "Notification", "PermissionRequest", "SubagentStart", "SubagentStop", "PreCompact", "Stop", "SessionEnd"].map((event) => [event, state])),
    PostToolUse: [{ matcher: "*", hooks: [hook("hook")] }],
    // a tool that fails never reaches PostToolUse, and its time would count as the model's
    PostToolUseFailure: [{ matcher: "*", hooks: [hook("hook")] }],
  };
}

/** An orchestration tab's Claude settings, kept in the meta dir so no Claude starting in a folder picks them up. */
export const orchestrationSettingsPath = (tab: string) => join(metaDir(), "orchestration", `${tab}.settings.json`);

/**
 * (Re)write the settings an orchestration tab's Claude loads with `--settings`: the agent-state hooks and the
 * guard, which sees `OVERBRIDGE_TAB` and applies the orchestrator's allow list. Idempotent.
 */
export function scaffoldOrchestration(tab: string): string {
  const file = orchestrationSettingsPath(tab);
  mkdirSync(dirname(file), { recursive: true });

  const settings = {
    env: { [ORCHESTRATION_ENV]: tab, OVERBRIDGE_ROOT: root(), OVERBRIDGE_NAME: "" },
    hooks: agentStateHooks(),
    ...pluginSettings(),
    plansDirectory: orchestrationPlansDir(),
  };

  mkdirSync(orchestrationPlansDir(), { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");

  return file;
}

/** The plugin settings a workspace Claude loads with `--settings`, kept in the meta dir like the orchestration ones. */
export const pluginSettingsPath = () => join(metaDir(), "plugins.settings.json");

/**
 * (Re)write the plugin settings and return their path. A workspace Claude gets them through `--settings` as well
 * as its settings.json, because Claude ignores a project's marketplaces in a folder it does not trust, and a
 * folder trusted by `claude-trust.ts` can lose that trust.
 */
export function scaffoldPlugins(): string {
  const file = pluginSettingsPath();
  mkdirSync(dirname(file), { recursive: true });
  // every tab's Claude launches at once when the session starts, so none may read a half-written file
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(pluginSettings(), null, 2) + "\n");
  renameSync(tmp, file);

  return file;
}

/** The orchestrator's brief, appended to its system prompt: it coordinates and starts workspaces for all work. */
export const orchestratorPrompt = () => `You are the overbridge orchestrator, running in the overbridge root (${root()}).
You coordinate: you read, check status and start workspaces. You never do the work yourself. A guard blocks
editing files, changing branches, committing, pushing, and creating or changing PRs and issues here.

When the user asks for any task (fixing something, filing a ticket, planning a spike, picking up or reviewing
a PR), start a workspace for it first, passing their request on, then stop:

- For a work item: \`overbridge start <repo> <id> --prompt "<the request, in the user's words>"\`
- For a PR (pick up, fix, resolve a conflict or review feedback, rebase): first look for the workspace that
  already has it. Run \`overbridge status --all\` and find the row whose \`pr\` is that PR, whose \`claim\` (or
  \`head\`) is the PR's head branch (\`gh pr view <pr> --json headRefName,url\`), or whose \`stack\` holds that
  branch. If one exists, do not start a duplicate: find that workspace's Claude with \`ListAgents\` (its session
  is named after the workspace, with an optional short suffix such as \`ws5-37\`) and send it
  \`/pickup #<pr> <anything else they asked>\` with \`SendMessage\`, passing \`notify_when_idle: true\` so you
  hear when it finishes. An agy workspace gets the same message through \`overbridge send\` (below). Tell the
  user which workspace took it. If that row is \`iceboxed\`, it has no agent to message: run
  \`overbridge thaw <workspace> --prompt "/pickup <pr-url> <anything else they asked>"\` (the URL, so its agent
  needs to ask nothing about the repo), which reopens its tab and has its agent read its handoff, then pick the
  PR up. Tell the user you thawed it. If \`thaw\` refuses, say why and stop;
  never start a second workspace for a branch an iceboxed one claims.
  Only when no workspace claims the branch, find the PR's item with
  \`overbridge item from-branch <its head branch>\` and run
  \`overbridge start <repo> <that id> --prompt "/pickup #<pr> <anything else they asked>"\`. A PR with no item
  uses \`--task pr-<number>\` instead of an id.
- With no item yet: \`overbridge start <repo> --task <short-slug> --prompt "<the request, in the user's words>"\`

Each workspace runs one agent: Claude Code (\`claude\`) or Antigravity CLI (\`agy\`). A new workspace gets the
root config.yml's \`agent\` (\`claude\` when unset). When the user asks for agy, AGY or
Antigravity, add \`--agent agy\` to \`overbridge start\`; when they ask for Claude, add \`--agent claude\`. A
workspace keeps its agent, so \`--agent\` does nothing for one that already exists.

The new workspace opens in its own tab and its Claude does the work. Tell the user which workspace and tab
opened. If \`overbridge start\` refuses, say why and stop. A refusal that names another workspace means that
workspace already holds the branch: message its Claude as above instead of retrying.

Every workspace's Claude session is named after its workspace (\`m4-conditions\`, not \`pioneer-40\`).
\`ListAgents\` lists it by that name, and \`SendMessage\` to the workspace name reaches it. A session started
before this may still carry an auto name: match it through \`overbridge status --all\`, or ask the user to
restart that tab. A workspace whose tab was closed gets its agent back with
\`overbridge tab <workspace> --prompt '<message>'\` (single quotes, as for \`overbridge send\`), which reopens its
tab and hands the agent the message as it starts. When the tab is still open, \`tab\` only focuses it and drops
the prompt: ask the user to restart that agent instead. \`tab\` and \`overbridge go\` move the user's focus, so run
them only when the user asks to see a workspace or no other way reaches its agent.

An agy workspace has no session for \`ListAgents\` or \`SendMessage\`. \`overbridge status --all\` marks it \`agy\` in
its last column (\`"agent": "agy"\` with \`--json\`). Reach it with \`overbridge send <workspace> '<message>'\` (single quotes: a backtick inside double quotes is refused), which
types the message into its agent pane and submits it. You do not hear when it finishes: check
\`overbridge status --all\` or its sidebar card later. Use \`overbridge send\` only for agy workspaces; a Claude
workspace takes \`SendMessage\`. To find branches still worth finishing, use the \`revisit\` skill: it reads
\`overbridge ahead --json\` and asks each workspace's Claude whether its commits are still relevant.

You may read anything, and run \`overbridge status --all\`, \`overbridge repo ls\`, \`overbridge worklist show\` (the ranked list the @work tab keeps; ask the user what to start next from it), \`overbridge item view\`, \`overbridge history\` (where each workspace's time went), read-only
\`git\` and \`gh\` commands, and the workspace admin commands (\`overbridge rm\`, \`icebox\`, \`thaw\`, \`release\`, \`up\`, \`tab\`, \`go\`, \`repo add\`). You may also message
workspace Claudes with \`ListAgents\` and \`SendMessage\`, and agy workspaces with \`overbridge send\`, for example to tell every tab to resume its work; the
\`whip\` skill does that for every workspace whose work is still outstanding. The \`cleanup\` skill finds finished
and orphaned workspaces with \`overbridge cleanup --json\` and removes the safe ones once the user confirms.
In Code Mode your only tools are \`REPL\` and \`Poll\`: call these from a REPL script (\`tools.ListAgents({})\`,
\`tools.SendMessage({...})\`, shell commands through \`$\`); the guard checks each call the script makes.`;

/**
 * Tells the agent to run repo commands through `overbridge shell` when the workspace holds several repos and
 * some declare a dev shell (a one-repo workspace starts the agent inside the shell instead). Empty otherwise.
 * A repo whose config does not load is skipped: the generated files must never block a launch.
 */
function devShellSection(ws: string): string {
  const repos = Object.keys(getWorkspace(readState(), ws).repos);

  if (repos.length < 2) return "";

  const withShell = repos.filter((repo) => {
    try {
      return loadRepoConfig(worktreePath(ws, repo), repo).shell !== undefined;
    } catch {
      return false;
    }
  });

  if (!withShell.length) return "";

  return `
## Dev shells

This workspace holds several repos, so you run in none of their dev shells. Run a repo's own tools through
\`overbridge shell <repo> -- <cmd>\`, such as \`overbridge shell ${withShell[0]} -- <cmd>\`. Run its lint, typecheck, test
and build commands (\`overbridge config get commands.test <repo-dir>\`) through \`overbridge check <repo> -- <cmd>\`,
which uses the same shell. Repos with a dev shell: ${withShell.join(", ")}.
A repo without one runs the command as it is, so both are always safe to use.
`;
}

const claudeMd = (ws: string, dir: string, devShells: string) => `# Workspace ${ws}

<!-- Generated by ws. Edits are overwritten. -->

You are bound to workspace **${ws}** (\`${dir}\`). A \`overbridge guard\` hook blocks
access to other workspaces and direct branch switching. Do not try to work around it.

- Each subdirectory is a git worktree of a repo. Commit, push and run tools there as normal.
- The workspace may start empty. \`overbridge repo ls\` lists registered repos; \`overbridge checkout <repo> <branch>\`
  adds the repo here if needed. \`overbridge repo add <name> <url>\` registers a new one.
- Change branch or pick up a PR only via \`overbridge checkout <repo> <branch>\` / \`overbridge checkout <repo> #<pr>\`.
  Never \`git switch\`, \`git checkout <branch>\`, or \`gh pr checkout\`.
- A branch, PR or issue claimed by another workspace cannot be taken (\`feat/383-x\` claims issue 383, so
  \`fix/383-y\` elsewhere is refused). If \`overbridge checkout\` refuses, stop and tell the user.
- After \`gh pr create\`, run \`overbridge pr <repo>\` to record the PR against this workspace.
- \`overbridge status\` shows this workspace's claims; \`overbridge status --all\` shows every workspace.
- \`overbridge release <repo>\` frees a branch when you are done with it.
- \`overbridge icebox <workspace>\` pauses a workspace you will not touch for a while (no process, no tab; claims stay);
  commit and push first. \`overbridge thaw <workspace>\` brings it back.
- One workspace per work item. To start a different item, run \`overbridge start <repo> <id>\` (it opens the
  item's own workspace and tab) rather than switching this one.
- Stacked PRs (\`gh stack\`): a claim covers every layer of its stack. \`gh stack init/add/up/down/top/bottom\`,
  \`push\`, \`submit\`, \`rebase\` and \`sync\` work as normal; pull an existing stack with \`overbridge checkout <repo> #<pr>\`
  (never \`gh stack checkout\` or \`gh stack trunk\`). Run \`overbridge pr <repo>\` after moving between layers or submitting.
- Run lint, typecheck, test, and build commands through \`overbridge check <repo> -- <cmd>\`. It queues them
  across all workspaces and runs several at once, in the repo's dev shell, while the machine's load allows. overbridge kills a run that
  goes over its time limit (exit 124) or stops using CPU (exit 137). If it cannot start in time, it gives up with exit 75.
- One check is one command: never chain commands inside it (\`sh -c 'a; b'\`, \`a && b\`). Queue each as its own
  \`overbridge check\`, \`cd\` before the call, and pipe the check's output (\`overbridge check <repo> -- vitest run a.ts | tail\`).
  Run package bins by name (\`nx\`, \`vitest\`, \`eslint\`, \`tsc\`): they run from \`node_modules/.bin\` with no \`npx\` or \`sh -c\`.
- Scope each check to what the branch changed: one file, one project, or an affected-only mode (\`nx affected -t <target> --base=origin/<base>\`,
  \`vitest run --changed origin/<base>\`, \`<base>\` being the PR's base branch). Do not run every project (\`nx run-many\` with no \`-p\`) or turn off the build cache: CI runs the full suite.
${devShells}
## GitHub repos

Name → URL map of the user's GitHub repos, cached at \`${ghReposCache()}\`. Refresh with:

\`\`\`
mkdir -p ${dirname(ghReposCache())} && gh repo list --limit 1000 --json name,url,sshUrl,isFork,isArchived,description > ${ghReposCache()}
\`\`\`

Register one with \`overbridge repo add <name> <sshUrl>\`; https clones of private repos fail.
${repoTable()}`;

type GhRepo = { name: string; url: string; isFork?: boolean; isArchived?: boolean };

/** Markdown table from the `gh repo list` cache, or a hint when there is none yet. */
function repoTable(): string {
  let repos: GhRepo[];

  try {
    repos = JSON.parse(readFileSync(ghReposCache(), "utf8"));
  } catch {
    return "\nNo cache yet; run the refresh command above.\n";
  }

  const rows = repos
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((r) => `| ${r.name} | ${r.url} | ${[r.isFork && "fork", r.isArchived && "archived"].filter(Boolean).join(", ")} |`);

  return ["", "| name | url | |", "| --- | --- | --- |", ...rows, ""].join("\n");
}
