import { checkout, createWorkspace, removeWorkspace } from "./commands";
import { getRepo, type RepoSpec } from "./config";
import * as git from "./git";
import { barePath, currentWorkspace, NAME_RE, worktreePath } from "./paths";
import { type PluginProblems, pluginProblems } from "./plugins";
import { providerFor } from "./pm";
import type { Provider } from "./pm/provider";
import { CONFIG_FILE, type ProjectConfig, parseYaml, ROOT_CONFIG_FILE, resolveConfig } from "./project-config";
import { scaffold } from "./scaffold";
import { switchTab } from "./sidebar";
import { openTab, TabFocus, tabOrder, type ZellijExec } from "./tab";
import { type Claim, isRemoving, readState, type State } from "./state";
import { fail, log, run } from "./util";

/**
 * The repo's `overbridge.yml` as committed on its default branch, so no worktree has to exist yet, with
 * the root config's layers applied.
 */
function committedConfig(spec: RepoSpec): ProjectConfig {
  const file = `${spec.name}:${CONFIG_FILE}`;
  const r = run(["git", "-C", barePath(spec.name), "show", `origin/${git.defaultBranch(spec)}:${CONFIG_FILE}`]);
  return resolveConfig(r.ok ? parseYaml(r.stdout, file) : undefined, spec.name, file);
}

function providerForRepo(spec: RepoSpec): Provider {
  const pm = committedConfig(spec).projectManagement;
  if (!pm) fail(`${spec.name}: no project-management in ${CONFIG_FILE} on ${git.defaultBranch(spec)} or in the root ${ROOT_CONFIG_FILE}`);
  return providerFor(pm, barePath(spec.name));
}

/** The prompt a caller passed, and the one a newly opened tab falls back to without it. */
type TabPrompt = { prompt?: string; defaultPrompt?: string };

/**
 * Bring `ws`'s tab to the front, since you asked for it, opening one with `prompt` (else `defaultPrompt`) when
 * it has none. An open tab already has its agent, so only an explicit `prompt` is reported as not sent.
 */
export function showTab(ws: string, prompts: TabPrompt = {}, exec: ZellijExec = run) {
  if (process.env.ZELLIJ && tabOrder(exec).includes(ws)) {
    switchTab(ws, exec);
    if (prompts.prompt) {
      log(`${ws} already has a tab; prompt not sent`);
    }
    return;
  }
  openTab(ws, prompts.prompt ?? prompts.defaultPrompt, TabFocus.Foreground, exec);
}

/** What `start` may inject: the provider, the zellij runner, the plugin check, and `--here`. */
type StartDeps = { provider?: Provider; exec?: ZellijExec; plugins?: () => PluginProblems; here?: boolean };

/**
 * `overbridge start <repo> <id>`: the work item gets its own workspace, named by its provider
 * (`ENG-123`, `gh-app-12`), holding `repo` on the item's branch, in a new tab opened in the background
 * whose agent runs `/start-item`. An item that already has a workspace, by name or by claim, gets its tab
 * focused, or opened when it has none.
 *
 * Run inside a workspace that holds `repo` on a `task/` branch with no PR (a ticket writer, a spike), it re-binds
 * that workspace to the item instead: the item's branch is claimed in place, carrying the task branch's commits
 * and uncommitted work, and no tab opens. `here` (`--here`) does the same from any workspace whose worktree is
 * clean, on a fresh branch from the default branch.
 */
export function start(repo: string, id: string, prompt?: string, deps: StartDeps = {}) {
  requirePlugins(deps.plugins);
  const spec = getRepo(repo);
  git.fetch(spec);
  const provider = deps.provider ?? providerForRepo(spec);
  const title = provider.title(id) ?? fail(`${id}: not found in ${provider.name}`);
  const name = provider.workspaceName(id, repo);
  if (!NAME_RE.test(name)) fail(`invalid workspace name '${name}' for ${id}`);
  const branch = provider.branchName({ id, title });
  const prompts = { prompt, defaultPrompt: `/start-item ${id}` };

  const state = readState();
  const ws = currentWorkspace();
  const claim = ws ? state.workspaces[ws]?.repos[repo] : undefined;
  if (ws && claim && claim.branch !== branch && (deps.here || isTaskClaim(claim))) {
    return rebind(ws, repo, id, branch, claim, prompt);
  }
  const holder = workspaceOf(state, repo, branch, provider);
  if (holder) {
    log(`${id} is in ${holder}`);
    showTab(holder, prompts, deps.exec);
    return console.log(holder);
  }
  openWorkspace(name, repo, branch, prompts, deps.exec);
}

/** Branch prefix for a workspace started with no work item. */
export const TASK_BRANCH_PREFIX = "task/";

/** A claim on a `task/` branch that has no PR yet: work with no item that can continue into one. */
const isTaskClaim = (c: Claim) => c.branch?.startsWith(TASK_BRANCH_PREFIX) === true && c.pr === undefined;

/**
 * Move workspace `ws`'s claim on `repo` from `claim` to the item's `branch`, in place. A task branch is the
 * base, so its commits and uncommitted changes carry over, and it is deleted afterwards when the item branch
 * holds everything it had (`git branch -d` refuses otherwise, and the branch is kept). Any other claim must be
 * clean, since the item's branch then starts from the default branch and nothing carries over.
 */
function rebind(ws: string, repo: string, id: string, branch: string, claim: Claim, prompt?: string) {
  const wt = worktreePath(ws, repo);
  const old = claim.branch;
  const task = isTaskClaim(claim);
  if (!task && (git.isDirty(wt) || git.hasUnpushed(wt))) {
    fail(`${ws}/${repo} has uncommitted changes or unpushed commits${old ? ` on ${old}` : ""}; commit and push them, or run without --here`);
  }
  checkout([repo, branch], ws, task ? { base: "HEAD" } : {});
  if (task && old) {
    if (run(["git", "-C", wt, "branch", "-d", old]).ok) log(`deleted ${old}`);
    else log(`kept ${old}: it has commits not on ${branch}`);
  }
  log(`${ws}/${repo} now on ${id}`);
  if (prompt) log(`${ws} already has its agent; prompt not sent`);
  console.log(ws);
}

/** The workspace, if any, whose claim on `repo` is the item `branch` names; a workspace being removed does not count. */
function workspaceOf(s: State, repo: string, branch: string, provider: Provider): string | undefined {
  const id = provider.idFromBranch(branch);
  for (const [ws, w] of Object.entries(s.workspaces)) {
    const b = w.repos[repo]?.branch;
    if (b && !isRemoving(w) && (b === branch || (id !== undefined && provider.idFromBranch(b) === id))) return ws;
  }
}

/**
 * `overbridge start <repo> --task <slug> --prompt <text>`: work with no item yet, such as filing a ticket or a
 * spike. The workspace is named `slug` and holds `repo` on a new claimed `task/<slug>` branch; its agent starts
 * with `prompt`, since there is no item to read.
 */
export function startTask(repo: string, slug: string, prompt: string, deps: { exec?: ZellijExec; plugins?: () => PluginProblems } = {}) {
  if (!NAME_RE.test(slug)) fail(`invalid task name '${slug}': use letters, digits, '.', '_' and '-'`);
  if (!prompt.trim()) fail("a task needs --prompt: say what the workspace's Claude should do");
  requirePlugins(deps.plugins);
  const spec = getRepo(repo);
  git.fetch(spec);
  openWorkspace(slug, repo, `${TASK_BRANCH_PREFIX}${slug}`, { prompt }, deps.exec);
}

/** Stop before any workspace exists when its Claude could not load the overbridge skills; print the warnings. */
function requirePlugins(check: () => PluginProblems = pluginProblems) {
  const { errors, warnings } = check();
  if (errors.length) {
    fail(`the new tab's Claude would not have the overbridge skills, so a command such as /start-item would be unknown:\n${errors.join("\n")}`);
  }
  warnings.forEach((w) => log(w));
}

/**
 * Create workspace `name` holding `repo` on `branch` and open its tab in the background, or show its tab when it
 * already exists, since you asked for it.
 */
function openWorkspace(name: string, repo: string, branch: string, prompts: TabPrompt, exec: ZellijExec = run) {
  if (readState().workspaces[name]) {
    log(`${name} already exists`);
    showTab(name, prompts, exec);
    return console.log(name);
  }

  createWorkspace(name, [repo]);
  try {
    checkout([repo, branch], name);
  } catch (e) {
    // a refused claim must not leave an empty workspace behind
    removeWorkspace(name, true);
    throw e;
  }
  scaffold(name);
  openTab(name, prompts.prompt ?? prompts.defaultPrompt, TabFocus.Background, exec);
  console.log(name);
}
