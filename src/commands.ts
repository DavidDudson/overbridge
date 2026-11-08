import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appendRepo, getRepo, initReposFile, loadRepos, REPO_NAME_RE } from "./config";
import * as git from "./git";
import { configPath, loadRepoConfig, parseConfig } from "./project-config";
import { layoutKdl, PER_PAGE } from "./layout";
import { barePath, currentWorkspace, envVar, metaDir, NAME_RE, root, selfCommand, worktreePath, wsDir } from "./paths";
import { scaffold } from "./scaffold";
import { chain, cover, hasGhStack, localStacks, remoteStack, type Stack, stackOf } from "./stack";
import { type Claim, claimOwner, getWorkspace, readState, withState } from "./state";
import { exec, fail, log, must, naturalSort, run } from "./util";

const SESSION = () => envVar("SESSION") ?? "workspaces";

/** What a workspace really holds in `repo`: its claim, its worktree head, and the stacks of either. */
const holdings = (repo: string, stacks: Stack[]) => (ws: string, c: Claim) =>
  cover(stacks, [c.branch, git.currentBranch(worktreePath(ws, repo))], [c.pr]);

function requireWs(explicit?: string): string {
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

export function newWorkspace(name: string | undefined, repos: string[]) {
  const state = readState();
  if (!name) {
    let n = 1;
    while (state.workspaces[`ws${n}`] || existsSync(wsDir(`ws${n}`))) n++;
    name = `ws${n}`;
  }
  if (!NAME_RE.test(name)) fail(`invalid workspace name '${name}'`);
  if (state.workspaces[name] || existsSync(wsDir(name))) fail(`workspace '${name}' already exists`);
  for (const r of repos) getRepo(r);
  mkdirSync(wsDir(name), { recursive: true });
  withState((s) => {
    s.workspaces[name] = { created: new Date().toISOString(), repos: {} };
  });
  scaffold(name);
  for (const r of repos) addRepo(r, name);
  console.log(name);
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
}

export function removeWorkspace(ws: string, force: boolean) {
  const w = getWorkspace(readState(), ws);
  if (!force) {
    const dirty = Object.keys(w.repos).filter((r) => git.isDirty(worktreePath(ws, r)));
    if (dirty.length) fail(`${ws} has uncommitted changes in: ${dirty.join(", ")} (use --force to discard)`);
  }
  for (const r of Object.keys(w.repos)) git.removeWorktree(getRepo(r), worktreePath(ws, r), force);
  rmSync(wsDir(ws), { recursive: true, force: true });
  withState((s) => {
    delete s.workspaces[ws];
  });
  log(`removed ${ws}`);
}

export function checkout(args: string[], wsOpt?: string) {
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
  let base = `origin/${git.defaultBranch(spec)}`;
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
    getWorkspace(s, ws).repos[repo] = { branch, pr: pr ?? git.prForBranch(wt, branch) };
  });
  const stack = stackOf(localStacks(repo), branch);
  log(`${ws}/${repo} → ${branch}${pr ? ` (PR #${pr})` : ""}${stack ? `\nstack: ${chain(stack)}` : ""}`);
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
    }
  });
}

export function status(all: boolean, json: boolean) {
  const s = readState();
  const cur = currentWorkspace();
  const names = (all || !cur ? Object.keys(s.workspaces) : [cur]).sort(naturalSort);
  const rows = names.flatMap((ws) => {
    const repos = Object.entries(getWorkspace(s, ws).repos);
    if (!repos.length)
      return [{ ws, repo: "", branch: "", pr: undefined as number | undefined, head: "", dirty: false, stack: undefined as Stack | undefined }];
    return repos.map(([repo, c]) => {
      const wt = worktreePath(ws, repo);
      const head = git.head(wt);
      const stacks = localStacks(repo);
      const stack = stackOf(stacks, head) ?? stackOf(stacks, c.branch);
      return { ws, repo, branch: c.branch ?? "", pr: c.pr, head, dirty: git.isDirty(wt), stack };
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
      r.dirty ? "dirty" : "",
    ]),
  );
}

function workspaceNames(): string[] {
  const names = Object.keys(readState().workspaces).sort(naturalSort);
  if (!names.length) fail("no workspaces yet; create one with `overbridge new`");
  return names;
}

export function layout() {
  process.stdout.write(layoutKdl(workspaceNames(), selfCommand()));
}

export function up(fresh: boolean) {
  if (process.env.ZELLIJ) fail("already inside zellij; detach first");
  const names = workspaceNames();
  names.forEach(scaffold);
  const file = join(metaDir(), "layout.kdl");
  writeFileSync(file, layoutKdl(names, selfCommand()));

  const session = SESSION();
  const sessions = run(["zellij", "list-sessions", "--short", "--no-formatting"]).stdout.split("\n");
  let exists = sessions.includes(session);
  if (exists && fresh) {
    run(["zellij", "kill-session", session]);
    run(["zellij", "delete-session", "--force", session]);
    exists = false;
  }
  if (exists) log(`attaching to ${session} (use \`overbridge up --fresh\` to rebuild the layout)`);
  process.exit(
    exists
      ? exec(["zellij", "attach", session])
      : exec(["zellij", "--session", session, "--new-session-with-layout", file]),
  );
}

/** Ensure `pages` full pages of workspaces exist (empty ones are fine), then rebuild the session. */
export function spinup(pages: number) {
  if (!Number.isInteger(pages) || pages < 1) fail("--pages must be a positive integer");
  if (process.env.ZELLIJ) fail("already inside zellij; detach first");
  init();
  const missing = pages * PER_PAGE - Object.keys(readState().workspaces).length;
  for (let i = 0; i < missing; i++) newWorkspace(undefined, []);
  up(true);
}

export function claude(ws: string, extra: string[]) {
  getWorkspace(readState(), ws);
  scaffold(ws);
  process.exit(exec(["claude", ...extra], { cwd: wsDir(ws), env: { OVERBRIDGE_NAME: ws, OVERBRIDGE_ROOT: root() } }));
}

export function whoami() {
  console.log(currentWorkspace() ?? fail("not inside a workspace"));
}

function table(header: string[], rows: string[][]) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  for (const r of all) console.log(r.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ").trimEnd());
}

/** The file or repo dir a `config` command targets: the arg, else the git root of the cwd. */
function configTarget(arg?: string): { dir: string; file: string } {
  const given = resolve(arg ?? (run(["git", "rev-parse", "--show-toplevel"]).stdout || process.cwd()));
  if (existsSync(given) && statSync(given).isFile()) return { dir: dirname(given), file: given };
  return { dir: given, file: configPath(given) };
}

export function configCheck(arg?: string) {
  const { file } = configTarget(arg);
  if (!existsSync(file)) fail(`${file} does not exist`);
  parseConfig(readFileSync(file, "utf8"), file);
  log(`${file}: ok`);
}

export function configShow(arg?: string) {
  const { dir, file } = configTarget(arg);
  if (!existsSync(file)) log(`${file} not found; showing defaults`);
  console.log(JSON.stringify(loadRepoConfig(dir), null, 2));
}
