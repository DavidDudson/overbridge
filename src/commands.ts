import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { appendRepo, getRepo, initReposFile, loadRepos, REPO_NAME_RE } from "./config";
import * as git from "./git";
import { configPath, getConfigValue, loadConfigFile, loadRepoConfig, loadRootLayers, rootConfigPath } from "./project-config";
import { agentDirOf, chooseLayout, userLayoutPath } from "./layout";
import { isOrchestrationTab, orchestrationRemoveMessage, type OrchestrationTab } from "./orchestration";
import { isOrphan, strayFiles, worktreesIn } from "./orphan";
import { restartAfter, STOP_SIGNALS } from "./orchestration-keep";
import { clearSubagents } from "./agent-state";
import { barePath, currentWorkspace, isInside, metaDir, NAME_RE, ORCHESTRATION_ENV, repoOf, root, selfCommand, sessionName, worktreePath, wsDir } from "./paths";
import { runHooks } from "./hooks";
import { orchestratorPrompt, scaffold, scaffoldOrchestration, scaffoldPlugins, workspaceSettingsPath } from "./scaffold";
import { defaultMux, layoutPath, type Mux, MuxKind, tmuxConfPath } from "./mux";
import { openTab, TabFocus } from "./tab";
import { runCheck } from "./check-queue";
import { trustFolder, untrustFolder } from "./claude-trust";
import { shellInvocation } from "./shell";
import { chain, cover, hasGhStack, localStacks, remoteStack, type Stack, stackOf } from "./stack";
import { type Claim, claimOwner, type ReboundFrom, getWorkspace, isIceboxed, readState, withState } from "./state";
import { exec, fail, log, must, naturalSort, run, shellQuote } from "./util";

/** What a workspace really holds in `repo`: its claim, its worktree head, and the stacks of either. */
export const holdings = (repo: string, stacks: Stack[]) => (ws: string, c: Claim) =>
  cover(stacks, [c.branch, git.currentBranch(worktreePath(ws, repo))], [c.pr]);

export function requireWs(explicit?: string): string {
  const ws = explicit ?? currentWorkspace();
  if (!ws) fail("not inside a workspace; cd into one or pass --ws <name>");
  getWorkspace(readState(), ws);
  return ws;
}

export function init() {
  for (const d of [root(), join(root(), ".bare"), metaDir()]) mkdirSync(d, { recursive: true });
  initReposFile();
  console.log(root());
}

export function repoAdd(name: string, url: string, branch?: string) {
  if (!REPO_NAME_RE.test(name)) fail(`invalid repo name '${name}' (letters, digits, - and _)`);
  if (loadRepos()[name]) fail(`repo '${name}' already registered`);
  const spec = { name, url, defaultBranch: branch };
  git.ensureBare(spec);
  appendRepo(spec);
  log(`registered ${name} (default branch ${git.defaultBranch(spec)})`);
}

export function repoList() {
  const repos = Object.values(loadRepos());
  table(
    ["repo", "url", "default", "cloned"],
    repos.map((r) => [r.name, r.url, r.defaultBranch ?? "(remote HEAD)", existsSync(barePath(r.name)) ? "yes" : "no"]),
  );
}

export function sync() {
  for (const spec of Object.values(loadRepos())) {
    log(`fetching ${spec.name}`);
    git.fetch(spec);
  }
}

export function newWorkspace(name: string | undefined, repos: string[], mux?: Mux) {
  if (!name) fail("usage: overbridge new <name> [-r repo]... (name it for its work item, e.g. ENG-123 or gh-app-12)");
  createWorkspace(name, repos);
  openTab(name, undefined, TabFocus.Background, mux);
  console.log(name);
}

/** Create workspace `name` holding a worktree of each of `repos`. */
export function createWorkspace(name: string, repos: string[]) {
  const state = readState();
  if (!NAME_RE.test(name)) fail(`invalid workspace name '${name}'`);
  if (state.workspaces[name] || existsSync(wsDir(name))) fail(`workspace '${name}' already exists`);
  for (const r of repos) getRepo(r);
  mkdirSync(wsDir(name), { recursive: true });
  trustFolder(wsDir(name));
  withState((s) => {
    s.workspaces[name] = { created: new Date().toISOString(), repos: {} };
  });
  scaffold(name);
  for (const r of repos) addRepo(r, name);
}

export function addRepo(repo: string, wsOpt?: string) {
  const ws = requireWs(wsOpt);
  const spec = getRepo(repo);
  if (getWorkspace(readState(), ws).repos[repo]) fail(`${repo} is already in ${ws}`);
  const path = worktreePath(ws, repo);
  if (existsSync(path)) fail(`${path} already exists`);
  log(`adding ${repo} to ${ws}`);
  git.addWorktree(spec, path);
  withState((s) => {
    getWorkspace(s, ws).repos[repo] = {};
  });
  warnShellLeak(ws, repo);
  scaffold(ws);
  runHooks("post-add", { ws, repo });
}

/** Which repo's dev shell the workspace's agent was launched in, if any (written by `claude()`). */
const agentShellFile = (ws: string) => join(metaDir(), "agent", `${ws}.shell`);
const agentShell = (ws: string) => (existsSync(agentShellFile(ws)) ? readFileSync(agentShellFile(ws), "utf8").trim() : undefined);

/** A repo added to a workspace whose agent runs inside another repo's shell: that env leaks into the agent. */
function warnShellLeak(ws: string, added: string) {
  const inside = agentShell(ws);
  if (!inside || inside === added) return;
  log(
    `warning: the agent in ${ws} runs inside ${inside}'s dev shell, so that env leaks into work on ${added}. ` +
      `Use \`overbridge shell ${added} -- <cmd>\` for ${added}'s own tools.`,
  );
}

export function removeWorkspace(ws: string, force: boolean) {
  if (isOrchestrationTab(ws)) {
    fail(orchestrationRemoveMessage(ws));
  }
  const state = readState();
  if (isOrphan(ws, state)) {
    return removeOrphan(ws, force);
  }
  const w = getWorkspace(state, ws);
  if (!force) {
    const dirty = Object.keys(w.repos).filter((r) => git.isDirty(worktreePath(ws, r)));
    if (dirty.length) fail(`${ws} has uncommitted changes in: ${dirty.join(", ")} (use --force to discard)`);
  }
  for (const [repo, claim] of Object.entries(w.repos)) {
    const ok = runHooks("pre-remove", { ws, repo, ...(claim.branch ? { branch: claim.branch } : {}), ...(claim.pr ? { pr: claim.pr } : {}) });
    if (!ok && !force) fail(`a pre-remove hook for ${ws}/${repo} failed; nothing was removed (use --force to remove anyway)`);
  }
  const removed: string[] = [];
  for (const r of Object.keys(w.repos)) {
    try {
      git.removeWorktree(getRepo(r), worktreePath(ws, r), force);
    } catch (e) {
      const cause = `removing the ${r} worktree failed: ${(e as Error).message}`;
      fail(removed.length ? `${ws} is partly removed (the ${removed.join(", ")} worktrees are gone); ${cause}` : `${ws}: ${cause}; nothing was removed`);
    }
    removed.push(r);
  }
  for (const repo of Object.keys(w.repos)) untrustFolder(worktreePath(ws, repo)); // the agent may have started in one
  removeFolder(ws);
  withState((s) => {
    delete s.workspaces[ws];
  });
  log(`removed ${ws}`);
}

/** Delete `ws`'s folder and its per-workspace files outside it: top cache, agent state, sidebar pane, tab layout. */
function removeFolder(ws: string) {
  untrustFolder(wsDir(ws));
  rmSync(wsDir(ws), { recursive: true, force: true });
  clearSubagents(metaDir(), ws);
  [join("top", `${ws}.json`), join("agent", `${ws}.json`), join("agent", `${ws}.shell`), join("sidebars", ws), join("tabs", `${ws}.kdl`), join("workspaces", `${ws}.settings.json`)].forEach((f) =>
    rmSync(join(metaDir(), f), { force: true }),
  );
}

/**
 * Remove an orphan: a workspace folder state does not list (`isOrphan`). Its registered worktrees are removed from
 * their bare repos and pruned, then the folder goes. Without `force` it refuses when a worktree holds uncommitted
 * changes or commits on no remote branch, or the folder holds files that are neither a worktree nor generated.
 */
export function removeOrphan(name: string, force: boolean) {
  const worktrees = worktreesIn(name);
  if (!force) {
    const unsaved = worktrees.filter((w) => git.isDirty(w.path) || git.hasUnpushed(w.path)).map((w) => w.repo);
    if (unsaved.length) {
      fail(`orphan ${name} has uncommitted changes or unpushed commits in: ${unsaved.join(", ")}; nothing was removed (use --force to discard)`);
    }
    const stray = strayFiles(wsDir(name), worktrees.map((w) => basename(w.path)));
    if (stray.length) {
      fail(`orphan ${name} holds files outside its worktrees: ${stray.join(", ")}; nothing was removed (move them, or use --force to discard)`);
    }
  }
  worktrees.forEach((w) => {
    git.removeWorktree(getRepo(w.repo), w.path, force);
    untrustFolder(w.path);
  });
  removeFolder(name);
  log(`removed orphan ${name}${worktrees.length ? ` (worktrees: ${worktrees.map((w) => w.repo).join(", ")})` : ""}`);
}

/**
 * `overbridge checkout <repo> <branch|#pr>`: claim `ref` for the workspace and switch its worktree to it.
 * A branch that exists neither locally nor on origin is created from `opts.base` (default: the remote default
 * branch); `start` passes `HEAD` to carry a task branch's work onto the item's branch, and `reboundFrom` to record
 * what the claim moved from (a plain checkout leaves no lineage).
 */
export function checkout(args: string[], wsOpt?: string, opts: { base?: string; reboundFrom?: ReboundFrom } = {}) {
  const ws = requireWs(wsOpt);
  let [repo, ref] = args;
  const owned = Object.keys(getWorkspace(readState(), ws).repos);
  if (repo && ref === undefined) {
    if (owned.length !== 1) fail("usage: overbridge checkout <repo> <branch|#pr>");
    [repo, ref] = [owned[0], repo];
  }
  if (!repo || !ref) fail("usage: overbridge checkout <repo> <branch|#pr>");
  if (!owned.includes(repo)) addRepo(repo, ws);

  const spec = getRepo(repo);
  const wt = worktreePath(ws, repo);
  git.fetch(spec);

  let branch = ref;
  let pr: number | undefined;
  let prUrl: string | undefined;
  let base = opts.base ?? `origin/${git.defaultBranch(spec)}`;
  let remote: Stack | undefined;
  const selector = git.parsePrRef(ref);
  if (selector) {
    const info = git.prInfo(wt, selector);
    pr = info.number;
    prUrl = info.url;
    branch = info.headRefName;
    if (info.isCrossRepository) {
      // Fork PR: track the PR head under a local pr-N branch.
      branch = `pr-${pr}`;
      base = `refs/remotes/origin/pr/${pr}`;
      must(["git", "-C", wt, "fetch", "--quiet", "origin", `+pull/${pr}/head:${base}`]);
    } else {
      remote = remoteStack(wt, pr);
      if (remote && !hasGhStack()) {
        log(`PR #${pr} is part of stack #${remote.number}; install gh-stack to pull every layer`);
        remote = undefined;
      }
    }
  } else {
    git.validateBranch(branch);
  }

  const stacks = localStacks(repo);
  const want = cover(stacks, [branch, ...(remote?.layers.map((l) => l.branch) ?? [])], [pr]);

  withState((s) => {
    const owner = claimOwner(s, repo, want, holdings(repo, stacks), ws);
    if (owner) fail(`${repo} ${pr ? `PR #${pr} (${branch})` : branch} (or its stack or issue) is claimed by workspace ${owner}`);
    // A URL, because gh stack reads a bare number as a stack number first.
    if (remote) must(["gh", "stack", "checkout", prUrl!], { cwd: wt });
    else git.switchTo(wt, branch, base);
    getWorkspace(s, ws).repos[repo] = { branch, pr: pr ?? git.prForBranch(wt, branch), ...(opts.reboundFrom ? { reboundFrom: opts.reboundFrom } : {}) };
  });
  const stack = stackOf(localStacks(repo), branch);
  log(`${ws}/${repo} → ${branch}${pr ? ` (PR #${pr})` : ""}${stack ? `\nstack: ${chain(stack)}` : ""}`);
  const claim = getWorkspace(readState(), ws).repos[repo];
  runHooks("post-checkout", { ws, repo, branch, ...(claim?.pr ? { pr: claim.pr } : {}) });
}

export function release(repo: string | undefined, wsOpt?: string) {
  const ws = requireWs(wsOpt);
  withState((s) => {
    const w = getWorkspace(s, ws);
    const repos = repo ? [repo] : Object.keys(w.repos);
    for (const r of repos) {
      if (!w.repos[r]) fail(`${r} is not in ${ws}`);
      // Detach in place: keeps files untouched, frees the branch for other worktrees.
      run(["git", "-C", worktreePath(ws, r), "switch", "--quiet", "--detach"]);
      w.repos[r] = {};
      log(`released ${ws}/${r}`);
    }
  });
}

export function recordPr(repo: string | undefined, wsOpt?: string) {
  const ws = requireWs(wsOpt);
  // hooks run after the lock is released, so a hook may call overbridge itself
  const found: { repo: string; branch: string; pr: number }[] = [];
  withState((s) => {
    const w = getWorkspace(s, ws);
    for (const r of repo ? [repo] : Object.keys(w.repos)) {
      const c = w.repos[r] ?? fail(`${r} is not in ${ws}`);
      // gh stack up/down/init/add move HEAD between layers; the claim follows it within a stack.
      const stacks = localStacks(r);
      const head = git.currentBranch(worktreePath(ws, r));
      const stack = stackOf(stacks, head);
      if (head && stack && head !== c.branch && (!c.branch || stackOf([stack], c.branch))) {
        const owner = claimOwner(s, r, cover(stacks, [head]), holdings(r, stacks), ws);
        if (owner) fail(`${r} stack ${chain(stack)} overlaps a claim by workspace ${owner}`);
        c.branch = head;
      }
      if (!c.branch) continue;
      c.pr = git.prForBranch(worktreePath(ws, r), c.branch);
      log(`${ws}/${r} ${c.branch}: ${c.pr ? `PR #${c.pr}` : "no PR"}`);
      if (c.pr) found.push({ repo: r, branch: c.branch, pr: c.pr });
    }
  });
  for (const f of found) runHooks("post-pr", { ws, ...f });
}

export function status(all: boolean, json: boolean) {
  const s = readState();
  const cur = currentWorkspace();
  const names = (all || !cur ? Object.keys(s.workspaces) : [cur]).sort(naturalSort);
  const rows = names.flatMap((ws) => {
    const repos = Object.entries(getWorkspace(s, ws).repos);
    const iceboxed = isIceboxed(getWorkspace(s, ws));
    if (!repos.length)
      return [{ ws, repo: "", branch: "", pr: undefined as number | undefined, head: "", dirty: false, iceboxed, stack: undefined as Stack | undefined, reboundFrom: undefined as ReboundFrom | undefined }];
    return repos.map(([repo, c]) => {
      const wt = worktreePath(ws, repo);
      const head = git.head(wt);
      const stacks = localStacks(repo);
      const stack = stackOf(stacks, head) ?? stackOf(stacks, c.branch);
      return { ws, repo, branch: c.branch ?? "", pr: c.pr, head, dirty: git.isDirty(wt), iceboxed, stack, reboundFrom: c.reboundFrom };
    });
  });
  if (json) return console.log(JSON.stringify(rows, null, 2));
  const stackCell = (r: (typeof rows)[number]) => {
    if (!r.stack) return "";
    const at = r.stack.layers.findIndex((l) => l.branch === r.head);
    return `${r.stack.number ? `#${r.stack.number}` : "local"} ${at < 0 ? "-" : at + 1}/${r.stack.layers.length}`;
  };
  table(
    ["ws", "repo", "claim", "pr", "head", "stack", ""],
    rows.map((r) => [
      r.ws === cur ? `${r.ws}*` : r.ws,
      r.repo,
      r.branch || (r.repo ? "-" : ""),
      r.pr ? `#${r.pr}` : "",
      r.head === r.branch ? "" : r.head,
      stackCell(r),
      [r.iceboxed ? "iceboxed" : "", r.dirty ? "dirty" : "", r.reboundFrom ? `from ${r.reboundFrom.branch}${r.reboundFrom.pr ? ` #${r.reboundFrom.pr}` : ""}` : ""].filter(Boolean).join(" "),
    ]),
  );
}

/** The workspaces that get a tab: every one but the iceboxed (`thaw` reopens those). */
function workspaceNames(): string[] {
  const all = readState().workspaces;
  const names = Object.keys(all).sort(naturalSort);
  if (!names.length) fail("no workspaces yet; create one with `overbridge new`");
  return names.filter((ws) => !isIceboxed(all[ws]));
}

/** Print the layout `up` would use; stderr says whether it is the user's file or the generated one. */
export function layout(mux: Mux = defaultMux()) {
  const choice = chooseLayout(workspaceNames(), selfCommand(), mux.kind);
  if (choice.source === "user") {
    log(`layout: ${choice.path} (user file, replaces the generated layout)`);
    process.stdout.write(readFileSync(choice.path, "utf8"));
  } else {
    log(mux.kind === MuxKind.Tmux ? "layout: generated tmux script" : `layout: generated (a file at ${userLayoutPath()} would replace it)`);
    process.stdout.write(choice.text);
  }
}

export function up(fresh: boolean, mux: Mux = defaultMux()) {
  if (mux.inSession()) fail(`already inside ${mux.kind}; detach first`);
  const names = workspaceNames();
  names.forEach(scaffold);
  const session = sessionName();
  const choice = chooseLayout(names, selfCommand(), mux.kind, session);
  let file: string;
  if (choice.source === "user") file = choice.path;
  else {
    file = layoutPath(mux.kind);
    writeFileSync(file, choice.text);
    if (choice.conf !== undefined) writeFileSync(tmuxConfPath(), choice.conf);
  }

  let exists = mux.sessionExists(session);
  if (exists && fresh) {
    mux.killSession(session);
    exists = false;
  }
  if (exists) log(`attaching to ${session} (use \`overbridge up --fresh\` to rebuild the layout)`);
  process.exit(exec(exists ? mux.attachCommand(session) : mux.createCommand(session, file)));
}

/** Name of the empty workspace `spinup` creates when there are none. */
export const SCRATCH = "scratch";

/** Rebuild the session over the existing workspaces; with none, create an empty scratch one first. */
export function spinup(mux: Mux = defaultMux()) {
  if (mux.inSession()) fail(`already inside ${mux.kind}; detach first`);
  init();
  if (!Object.keys(readState().workspaces).length) createWorkspace(SCRATCH, []);
  up(true, mux);
}

/**
 * Launch the agent in `agentDir` (the repo folder, so its `overbridge.yml` is found; see `layout.ts`). With
 * exactly one repo that declares a dev shell it starts inside it; with several it starts plain and the workspace
 * CLAUDE.md points it at `overbridge shell`. Started in a repo folder it loads the workspace settings through
 * `--settings`, because Claude reads `.claude/settings.json` only from its own folder (CLAUDE.md it finds upward).
 */
export function claude(ws: string, extra: string[]) {
  const repos = Object.keys(getWorkspace(readState(), ws).repos);
  scaffold(ws);
  const cwd = agentDirOf(ws);
  trustFolder(wsDir(ws));
  if (cwd !== wsDir(ws)) trustFolder(cwd);
  const [only] = repos;
  const spec = repos.length === 1 && only ? loadRepoConfig(worktreePath(ws, only), only).shell : undefined;
  const settings = cwd === wsDir(ws) ? scaffoldPlugins() : workspaceSettingsPath(ws);
  const inv = shellInvocation(only ?? "", only ? worktreePath(ws, only) : wsDir(ws), spec, ["claude", "--settings", settings, ...extra], cwd);
  mkdirSync(dirname(agentShellFile(ws)), { recursive: true });
  if (spec && only) writeFileSync(agentShellFile(ws), only);
  else rmSync(agentShellFile(ws), { force: true });
  process.exit(exec(inv.cmd, { cwd: inv.cwd, env: { ...inv.env, OVERBRIDGE_NAME: ws, OVERBRIDGE_ROOT: root() } }));
}

/**
 * The orchestrator's `claude` argv: its settings (hooks and guard) and its brief appended to the system prompt.
 */
export const orchestrationArgs = (settings: string, extra: readonly string[]) => [
  "claude",
  "--settings",
  settings,
  "--append-system-prompt",
  orchestratorPrompt(),
  ...extra,
];

/**
 * Run an orchestration tab's Claude in its folder, with the agent-state hooks, the orchestrator guard and its
 * brief, and start a fresh session each time one ends, so the tab always has one. `extra` applies to the first
 * session only. Closing the tab or the session (a hang-up or terminate signal) stops the loop.
 * `OVERBRIDGE_NAME` is blanked so a value inherited from the launching shell cannot bind it to a workspace.
 */
export function claudeOrchestration(t: OrchestrationTab, extra: string[]): never {
  const env = { ...process.env, OVERBRIDGE_NAME: "", [ORCHESTRATION_ENV]: t.tab, OVERBRIDGE_ROOT: root() };
  // Ctrl-C belongs to Claude; without a handler it would also kill this loop
  process.on("SIGINT", () => {});
  const session = (args: string[], streak: number): never => {
    const startedMs = Date.now();
    const p = Bun.spawnSync({ cmd: orchestrationArgs(scaffoldOrchestration(t.tab), args), cwd: t.dir(), env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (p.signalCode && STOP_SIGNALS.has(String(p.signalCode))) {
      process.exit(1);
    }
    const next = restartAfter(Date.now() - startedMs, streak);
    if (next.delayMs) {
      log(`${t.tab}: claude exited quickly ${next.streak} times in a row; starting a fresh session in ${next.delayMs / 1_000}s`);
      Bun.sleepSync(next.delayMs);
    } else {
      log(`${t.tab}: claude exited; starting a fresh session`);
    }
    return session([], next.streak);
  };
  return session(extra, 0);
}

/** `overbridge shell <repo> -- <cmd>`: run `cmd` in the repo's dev shell, or as it is when the repo has none. */
/** `cmd` in `repo`'s dev shell, run from the cwd when it is inside the worktree, else from the worktree. */
function inRepoShell(ws: string, repo: string, cmd: string[]) {
  if (!getWorkspace(readState(), ws).repos[repo]) fail(`${repo} is not in ${ws}`);
  const dir = worktreePath(ws, repo);
  const here = process.cwd();
  const config = loadRepoConfig(dir, repo);
  return { config, inv: shellInvocation(repo, dir, config.shell, cmd, isInside(here, dir) ? here : dir) };
}

export function shell(repo: string, cmd: string[], wsOpt?: string) {
  const ws = requireWs(wsOpt);
  if (!cmd.length) fail("usage: overbridge shell <repo> [--ws name] -- <cmd>...");
  const { inv } = inRepoShell(ws, repo, cmd);
  process.exit(exec(inv.cmd, { cwd: inv.cwd, env: inv.env }));
}

/**
 * `overbridge check [repo] -- <cmd>`: run `cmd` in the repo's dev shell through the shared check queue. The repo
 * defaults to the one the cwd is in, then to the workspace's only repo.
 */
export async function check(repoArg: string | undefined, cmd: string[], wsOpt?: string, timeoutSeconds?: number): Promise<number> {
  const ws = requireWs(wsOpt);
  const repos = Object.keys(getWorkspace(readState(), ws).repos);
  const here = repoOf(process.cwd());
  const repo =
    repoArg ??
    (here && repos.includes(here) ? here : undefined) ??
    (repos.length === 1 ? repos[0] : undefined) ??
    fail(`name the repo to check in: overbridge check <repo> -- <cmd> (${ws} holds ${repos.join(", ") || "no repos"})`);
  const { config, inv } = inRepoShell(ws, repo, cmd);
  const settings = timeoutSeconds === undefined ? config.checkQueue : { ...config.checkQueue, timeoutSeconds };
  return runCheck(inv, { ws, repo, command: cmd.map(shellQuote).join(" ") }, settings);
}

export function whoami() {
  console.log(currentWorkspace() ?? fail("not inside a workspace"));
}

export function table(header: string[], rows: string[][]) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  for (const r of all) console.log(r.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ").trimEnd());
}

/**
 * The file a `config` command targets (the arg, else the git root of the cwd) and the repo it belongs to,
 * which picks the root config's `repos.<name>` layer.
 */
function configTarget(arg?: string): { file: string; repo?: string } {
  const given = resolve(arg ?? (run(["git", "rev-parse", "--show-toplevel"]).stdout || process.cwd()));
  const isFile = existsSync(given) && statSync(given).isFile();
  const file = isFile ? given : configPath(given);
  const repo = repoOf(isFile ? dirname(given) : given);
  return repo === undefined ? { file } : { file, repo };
}

/**
 * Check a repo's config with the root config's layers, or the root `config.yml` alone when that is the
 * target. Either file may be missing, but not both.
 */
export function configCheck(arg?: string) {
  const { file, repo } = configTarget(arg);
  const rootFile = rootConfigPath();
  if (file === rootFile) {
    if (!existsSync(file)) fail(`${file} does not exist`);
    loadRootLayers(file);
    return log(`${file}: ok`);
  }
  const present = [file, rootFile].filter((f) => existsSync(f));
  if (!present.length) fail(`${file} does not exist`);
  loadConfigFile(file, repo);
  log(`${present.join(" + ")}: ok`);
}

/** The resolved config as JSON. Which files went into it goes to stderr. */
export function configShow(arg?: string) {
  const { file, repo } = configTarget(arg);
  const present = [file, rootConfigPath()].filter((f) => existsSync(f));
  log(present.length ? `from ${present.join(" + ")}` : `${file} not found; showing defaults`);
  console.log(JSON.stringify(loadConfigFile(file, repo), null, 2));
}

/** Print one resolved value: strings bare, everything else as JSON. Exits non-zero when the key is unset. */
export function configGet(key: string, arg?: string) {
  const { file, repo } = configTarget(arg);
  const value = getConfigValue(loadConfigFile(file, repo), key);
  if (value === undefined) fail(`${key} is not set`);
  console.log(typeof value === "string" ? value : JSON.stringify(value));
}
