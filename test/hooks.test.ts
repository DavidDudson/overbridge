import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHooks } from "../src/hooks";
import { parseConfig } from "../src/project-config";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let tmp: string;
let root: string;
let logFile: string;

const env = () => ({
  ...process.env,
  OVERBRIDGE_ROOT: root,
  OVERBRIDGE_NAME: "",
  ZELLIJ: "",
  ZELLIJ_CONFIG_DIR: join(tmp, "zellij-config"),
  XDG_CACHE_HOME: join(tmp, "cache"),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  HOOK_LOG: logFile,
});

function ob(args: string[], cwd = tmp) {
  const p = Bun.spawnSync({ cmd: [process.execPath, CLI, ...args], cwd, env: env(), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function sh(cmd: string[], cwd: string) {
  const p = Bun.spawnSync({ cmd, cwd, env: env(), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
}

const record = 'echo "$OVERBRIDGE_HOOK $OVERBRIDGE_NAME $OVERBRIDGE_REPO branch=$OVERBRIDGE_BRANCH pr=$OVERBRIDGE_PR pwd=$(pwd)" >> "$HOOK_LOG"';
const hookLog = () => (existsSync(logFile) ? readFileSync(logFile, "utf8") : "");
const writeRoot = (yaml: string) => writeFileSync(join(root, "config.yml"), yaml);

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-hooks-")));
  root = join(tmp, "workspaces");
  logFile = join(tmp, "hooks.log");
  const src = join(tmp, "src");
  sh(["git", "init", "-q", "-b", "main", src], tmp);
  sh(["git", "commit", "-q", "--allow-empty", "-m", "init"], src);
  sh(["git", "branch", "topic"], src);
  sh(["git", "clone", "-q", "--bare", src, join(tmp, "remote.git")], tmp);
  expect(ob(["init"]).code).toBe(0);
  expect(ob(["repo", "add", "app", join(tmp, "remote.git")]).code).toBe(0);
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("config", () => {
  test("a repo's own overbridge.yml can't declare hooks", () => {
    expect(() => parseConfig("hooks:\n  post-add: make\n", "f.yml")).toThrow("hooks: only allowed in the root config.yml");
  });

  test("the root config validates hook names and values", () => {
    writeRoot("defaults:\n  hooks:\n    post-ad: x\n    post-pr: [a, 3]\n    pre-remove: ''\n");
    const r = ob(["config", "check", join(root, "config.yml")]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("hooks.post-ad: unknown key, did you mean 'post-add'?");
    expect(r.err).toContain("hooks.post-pr[1]: expected a non-empty string");
    expect(r.err).toContain("hooks.pre-remove: expected a non-empty string");
  });
});

describe("lifecycle", () => {
  test("post-add and post-checkout run in the worktree, with stdout kept off the command's own output", () => {
    writeRoot(`defaults:\n  hooks:\n    post-add: ['${record}', 'echo noisy']\nrepos:\n  app:\n    hooks:\n      post-checkout: '${record}'\n`);
    const created = ob(["new", "w1", "-r", "app"]);
    expect(created.code).toBe(0);
    expect(created.out).toBe("w1\n");
    expect(created.err).toContain("noisy");
    expect(ob(["checkout", "app", "topic"], join(root, "w1", "app")).code).toBe(0);
    const wt = join(root, "w1", "app");
    expect(hookLog()).toBe(`post-add w1 app branch= pr= pwd=${wt}\npost-checkout w1 app branch=topic pr= pwd=${wt}\n`);
  });

  test("a failing post hook warns but the command succeeds", () => {
    writeRoot("defaults:\n  hooks:\n    post-add: 'exit 4'\n");
    const r = ob(["new", "w2", "-r", "app"]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("post-add hook failed with exit code 4: exit 4");
    expect(existsSync(join(root, "w2", "app", ".git"))).toBe(true);
  });

  test("a failing pre-remove stops rm, and --force removes anyway", () => {
    writeRoot("defaults:\n  hooks:\n    pre-remove: ['exit 1', 'echo never >> \"$HOOK_LOG\"']\n");
    const refused = ob(["rm", "w2"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("a pre-remove hook for w2/app failed; nothing was removed");
    expect(existsSync(join(root, "w2"))).toBe(true);
    expect(hookLog()).not.toContain("never");
    expect(ob(["rm", "w2", "--force"]).code).toBe(0);
    expect(existsSync(join(root, "w2"))).toBe(false);
  });

  test("pre-remove is told the claimed branch", () => {
    rmSync(logFile, { force: true });
    writeRoot(`defaults:\n  hooks:\n    pre-remove: '${record}'\n`);
    expect(ob(["rm", "w1"]).code).toBe(0);
    expect(hookLog()).toBe(`pre-remove w1 app branch=topic pr= pwd=${join(root, "w1", "app")}\n`);
  });

  test("a config that can't be read skips the hooks with a warning", () => {
    writeRoot("defaults:\n  hooks: {}\n");
    expect(ob(["new", "w3", "-r", "app"]).code).toBe(0);
    writeFileSync(join(root, "w3", "app", "overbridge.yml"), "ide: emacs\n");
    const r = ob(["checkout", "app", "topic"], join(root, "w3", "app"));
    expect(r.code).toBe(0);
    expect(r.err).toContain("post-checkout hooks skipped for w3/app");
  });

  test("post-pr is told the PR number", () => {
    rmSync(logFile, { force: true });
    writeRoot(`defaults:\n  hooks:\n    post-pr: '${record}'\n`);
    rmSync(join(root, "w3", "app", "overbridge.yml"));
    const saved = { root: process.env.OVERBRIDGE_ROOT, log: process.env.HOOK_LOG };
    process.env.OVERBRIDGE_ROOT = root;
    process.env.HOOK_LOG = logFile;
    try {
      expect(runHooks("post-pr", { ws: "w3", repo: "app", branch: "topic", pr: 42 })).toBe(true);
    } finally {
      saved.root === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved.root);
      saved.log === undefined ? delete process.env.HOOK_LOG : (process.env.HOOK_LOG = saved.log);
    }
    expect(hookLog()).toBe(`post-pr w3 app branch=topic pr=42 pwd=${join(root, "w3", "app")}\n`);
  });
});
