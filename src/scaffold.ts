import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ghReposCache, metaDir, ORCHESTRATION_ENV, root, selfCommand, worktreePath, wsDir } from "./paths";
import { pluginSettings } from "./plugins";
import { loadRepoConfig } from "./project-config";
import { getWorkspace, readState } from "./state";
import { shellQuote } from "./util";

/** Where plan-mode plans are written, relative to the workspace folder. */
export const PLANS_DIR = "plans";

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
  const settings = {
    env: { OVERBRIDGE_NAME: ws, OVERBRIDGE_ROOT: root() },
    ...pluginSettings(),
    // plan-mode plans live in the workspace folder, not ~/.claude/plans
    plansDirectory: PLANS_DIR,
    permissions: { allow: ALLOWED_COMMANDS },
    autoMode: { allow: ["$defaults", ...AUTO_MODE_ALLOW] },
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [hook("guard")] }],
      ...agentStateHooks(),
    },
  };
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings, null, 2) + "\n");
  writeFileSync(join(dir, "CLAUDE.md"), claudeMd(ws, dir, devShellSection(ws)));
}

const hook = (sub: string) => ({ type: "command", command: [...selfCommand(), sub].map(shellQuote).join(" ") });

/** The hooks that record what an agent is doing, for the sidebar glyphs: see agent-hook.ts. */
function agentStateHooks() {
  const state = [{ hooks: [hook("hook")] }];
  return {
    ...Object.fromEntries(["SessionStart", "UserPromptSubmit", "Notification", "PreCompact", "Stop", "SessionEnd"].map((event) => [event, state])),
    PostToolUse: [{ matcher: "*", hooks: [hook("hook")] }],
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
    hooks: { PreToolUse: [{ matcher: "*", hooks: [hook("guard")] }], ...agentStateHooks() },
    ...pluginSettings(),
  };
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
- For a PR: find its item with \`overbridge item from-branch <its head branch>\`, then
  \`overbridge start <repo> <that id> --prompt "/pickup #<pr> <anything else they asked>"\`. A PR with no item
  uses \`--task pr-<number>\` instead of an id.
- With no item yet: \`overbridge start <repo> --task <short-slug> --prompt "<the request, in the user's words>"\`

The new workspace opens in its own tab and its Claude does the work. Tell the user which workspace and tab
opened. If \`overbridge start\` refuses, say why and stop.

You may read anything, and run \`overbridge status --all\`, \`overbridge repo ls\`, \`overbridge item view\`, read-only
\`git\` and \`gh\` commands, and the workspace admin commands (\`overbridge rm\`, \`release\`, \`up\`, \`repo add\`). You may also message
workspace Claudes with \`ListAgents\` and \`SendMessage\`, for example to tell every tab to resume its work.`;

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
- One workspace per work item. To start a different item, run \`overbridge start <repo> <id>\` (it opens the
  item's own workspace and tab) rather than switching this one.
- Stacked PRs (\`gh stack\`): a claim covers every layer of its stack. \`gh stack init/add/up/down/top/bottom\`,
  \`push\`, \`submit\`, \`rebase\` and \`sync\` work as normal; pull an existing stack with \`overbridge checkout <repo> #<pr>\`
  (never \`gh stack checkout\` or \`gh stack trunk\`). Run \`overbridge pr <repo>\` after moving between layers or submitting.
- Run lint, typecheck, test, and build commands through \`overbridge check <repo> -- <cmd>\`. Only one runs at a time
  across all workspaces. It runs in the repo's dev shell once the machine's load allows. overbridge kills a run that
  goes over its time limit (exit 124) or stops using CPU (exit 137). If no turn comes in time, it gives up with exit 75.
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
