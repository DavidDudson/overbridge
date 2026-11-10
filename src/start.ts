import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkout, createWorkspace, removeWorkspace } from "./commands";
import { getRepo, type RepoSpec } from "./config";
import * as git from "./git";
import { newTabKdl } from "./layout";
import { barePath, metaDir, NAME_RE, selfCommand } from "./paths";
import { type PluginProblems, pluginProblems } from "./plugins";
import { providerFor } from "./pm";
import type { Provider } from "./pm/provider";
import { CONFIG_FILE, type ProjectConfig, parseYaml, ROOT_CONFIG_FILE, resolveConfig } from "./project-config";
import { sidebarWidth } from "./config";
import { scaffold } from "./scaffold";
import { currentTab, switchTab } from "./sidebar";
import { readState } from "./state";
import { fail, log, run, type RunResult } from "./util";

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

type Exec = (cmd: string[]) => RunResult;

/**
 * Open `ws` as a new tab of the running zellij session, its agent starting with `prompt`, and stay on the
 * tab you were on. Outside zellij there is no session to add to, so say how to get one.
 */
export function openTab(ws: string, prompt?: string, exec: Exec = (cmd) => run(cmd)) {
  if (!process.env.ZELLIJ) return log(`${ws} created; run \`overbridge up\` to open its tab`);
  const dir = join(metaDir(), "tabs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ws}.kdl`);
  writeFileSync(file, newTabKdl(ws, selfCommand(), { sidebarWidth: sidebarWidth(), focus: true, ...(prompt ? { prompt } : {}) }));
  const back = currentTab(exec);
  const r = exec(["zellij", "action", "new-tab", "--layout", file, "--name", ws]);
  if (!r.ok) {
    return log(`could not open a tab for ${ws}: ${r.stderr || r.stdout}`);
  }
  // new-tab always focuses the tab it makes. The bare go-to-tab-name, not switchTab, returns focus to the pane you left.
  if (back !== undefined) {
    exec(["zellij", "action", "go-to-tab-name", back]);
  }
}

/**
 * `overbridge start <repo> <id>`: the work item gets its own workspace, named by its provider
 * (`ENG-123`, `gh-app-12`), holding `repo` on the item's branch, in a new tab opened in the background
 * whose agent runs `/start-item`. An item that already has a workspace gets its tab focused, since you asked for it.
 */
export function start(repo: string, id: string, prompt?: string, deps: { provider?: Provider; exec?: Exec; plugins?: () => PluginProblems } = {}) {
  requirePlugins(deps.plugins);
  const spec = getRepo(repo);
  git.fetch(spec);
  const provider = deps.provider ?? providerForRepo(spec);
  const title = provider.title(id) ?? fail(`${id}: not found in ${provider.name}`);
  const name = provider.workspaceName(id, repo);
  if (!NAME_RE.test(name)) fail(`invalid workspace name '${name}' for ${id}`);
  openWorkspace(name, repo, provider.branchName({ id, title }), prompt ?? `/start-item ${id}`, deps.exec);
}

/** Branch prefix for a workspace started with no work item. */
export const TASK_BRANCH_PREFIX = "task/";

/**
 * `overbridge start <repo> --task <slug> --prompt <text>`: work with no item yet, such as filing a ticket or a
 * spike. The workspace is named `slug` and holds `repo` on a new claimed `task/<slug>` branch; its agent starts
 * with `prompt`, since there is no item to read.
 */
export function startTask(repo: string, slug: string, prompt: string, deps: { exec?: Exec; plugins?: () => PluginProblems } = {}) {
  if (!NAME_RE.test(slug)) fail(`invalid task name '${slug}': use letters, digits, '.', '_' and '-'`);
  if (!prompt.trim()) fail("a task needs --prompt: say what the workspace's Claude should do");
  requirePlugins(deps.plugins);
  const spec = getRepo(repo);
  git.fetch(spec);
  openWorkspace(slug, repo, `${TASK_BRANCH_PREFIX}${slug}`, prompt, deps.exec);
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
 * Create workspace `name` holding `repo` on `branch` and open its tab in the background, or focus it when it
 * already exists, since you asked for it.
 */
function openWorkspace(name: string, repo: string, branch: string, prompt: string, exec?: Exec) {
  if (readState().workspaces[name]) {
    log(`${name} already exists${process.env.ZELLIJ ? "; switching to it" : ""}`);
    if (process.env.ZELLIJ) switchTab(name, exec);
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
  openTab(name, prompt, exec);
  console.log(name);
}
