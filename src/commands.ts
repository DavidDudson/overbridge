import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRepo, getRepo, initReposFile, loadRepos, REPO_NAME_RE } from "./config";
import * as git from "./git";
import { layoutKdl } from "./layout";
import { barePath, currentWorkspace, metaDir, NAME_RE, root, selfCommand, worktreePath, wsDir } from "./paths";
import { scaffold } from "./scaffold";
import { claimOwner, getWorkspace, readState, withState } from "./state";
import { exec, fail, log, must, naturalSort, run } from "./util";

const SESSION = () => process.env.WS_SESSION ?? "workspaces";

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
    if (owned.length !== 1) fail("usage: ws checkout <repo> <branch|#pr>");
    [repo, ref] = [owned[0], repo];
  }
  if (!repo || !ref) fail("usage: ws checkout <repo> <branch|#pr>");
  if (!owned.includes(repo)) fail(`${repo} is not in ${ws}; run \`ws add ${repo}\``);

  const spec = getRepo(repo);
  const wt = worktreePath(ws, repo);
  git.fetch(spec);

  let branch = ref;
  let pr: number | undefined;
  let base = `origin/${git.defaultBranch(spec)}`;
  const selector = git.parsePrRef(ref);
  if (selector) {
    const info = git.prInfo(wt, selector);
    pr = info.number;
    branch = info.headRefName;
    if (info.isCrossRepository) {
      // Fork PR: track the PR head under a local pr-N branch.
      branch = `pr-${pr}`;
      base = `refs/remotes/origin/pr/${pr}`;
      must(["git", "-C", wt, "fetch", "--quiet", "origin", `+pull/${pr}/head:${base}`]);
    }
  } else {
    git.validateBranch(branch);
  }

  withState((s) => {
    const owner = claimOwner(s, repo, { branch, pr });
    if (owner && owner !== ws) {
      fail(`${repo} ${pr ? `PR #${pr} (${branch})` : branch} is claimed by workspace ${owner}`);
    }
    git.switchTo(wt, branch, base);
    getWorkspace(s, ws).repos[repo] = { branch, pr: pr ?? git.prForBranch(wt, branch) };
  });
  log(`${ws}/${repo} → ${branch}${pr ? ` (PR #${pr})` : ""}`);
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
    if (!repos.length) return [{ ws, repo: "", branch: "", pr: undefined as number | undefined, head: "", dirty: false }];
    return repos.map(([repo, c]) => {
      const wt = worktreePath(ws, repo);
      return { ws, repo, branch: c.branch ?? "", pr: c.pr, head: git.head(wt), dirty: git.isDirty(wt) };
    });
  });
  if (json) return console.log(JSON.stringify(rows, null, 2));
  table(
    ["ws", "repo", "claim", "pr", "head", ""],
    rows.map((r) => [
      r.ws === cur ? `${r.ws}*` : r.ws,
      r.repo,
      r.branch || (r.repo ? "-" : ""),
      r.pr ? `#${r.pr}` : "",
      r.head === r.branch ? "" : r.head,
      r.dirty ? "dirty" : "",
    ]),
  );
}

function workspaceNames(): string[] {
  const names = Object.keys(readState().workspaces).sort(naturalSort);
  if (!names.length) fail("no workspaces yet; create one with `ws new`");
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
  if (exists) log(`attaching to ${session} (use \`ws up --fresh\` to rebuild the layout)`);
  process.exit(
    exists
      ? exec(["zellij", "attach", session])
      : exec(["zellij", "--session", session, "--new-session-with-layout", file]),
  );
}

export function claude(ws: string, extra: string[]) {
  getWorkspace(readState(), ws);
  scaffold(ws);
  process.exit(exec(["claude", ...extra], { cwd: wsDir(ws), env: { WS_NAME: ws, WS_ROOT: root() } }));
}

export function whoami() {
  console.log(currentWorkspace() ?? fail("not inside a workspace"));
}

function table(header: string[], rows: string[][]) {
  const all = [header, ...rows];
  const widths = header.map((_, i) => Math.max(...all.map((r) => (r[i] ?? "").length)));
  for (const r of all) console.log(r.map((c, i) => (c ?? "").padEnd(widths[i]!)).join("  ").trimEnd());
}
