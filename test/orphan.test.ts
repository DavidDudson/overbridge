import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HELD_ENV } from "../src/check-queue";
import { CleanupReason, CleanupVerdict, type Finding } from "../src/cleanup-scan";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let tmp: string;
let root: string;

const env = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== HELD_ENV)),
  OVERBRIDGE_ROOT: root,
  OVERBRIDGE_NAME: "",
  OVERBRIDGE_TAB: "",
  ZELLIJ: "",
  ZELLIJ_CONFIG_DIR: join(root, "zellij-config"),
  XDG_CACHE_HOME: join(tmp, "cache"),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

function ob(args: string[]) {
  const p = Bun.spawnSync({ cmd: [process.execPath, CLI, ...args], cwd: tmp, env: env(), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function sh(cmd: string[], cwd: string) {
  const p = Bun.spawnSync({ cmd, cwd, env: env(), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
  }
  return p.stdout.toString().trim();
}

const statePath = () => join(root, ".overbridge", "state.json");

/** A workspace that state has forgotten: its folder and registered worktree stay behind. */
function orphan(name: string): string {
  expect(ob(["new", name, "-r", "app"]).code).toBe(0);
  const state = JSON.parse(readFileSync(statePath(), "utf8")) as { workspaces: Record<string, unknown> };
  const { [name]: _dropped, ...workspaces } = state.workspaces;
  writeFileSync(statePath(), JSON.stringify({ ...state, workspaces }));
  return join(root, name);
}

const registered = () => sh(["git", "-C", join(root, ".bare", "app.git"), "worktree", "list"], tmp);
const findings = () => JSON.parse(ob(["cleanup", "--json", "--no-fetch"]).out) as Finding[];
const finding = (ws: string) => findings().find((f) => f.ws === ws);

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ob-orphan-")));
  root = join(tmp, "workspaces");
  const src = join(tmp, "src");
  sh(["git", "init", "-q", "-b", "main", src], tmp);
  sh(["git", "commit", "-q", "--allow-empty", "-m", "init"], src);
  const remote = join(tmp, "remote.git");
  sh(["git", "clone", "-q", "--bare", src, remote], tmp);
  expect(ob(["init"]).code).toBe(0);
  expect(ob(["repo", "add", "app", remote]).code).toBe(0);
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("orphan folders", () => {
  test("status does not list an orphan, cleanup reports it and rm removes it with its worktree", () => {
    const dir = orphan("ENG-9");
    expect(ob(["status", "--all"]).out).not.toContain("ENG-9");
    expect(registered()).toContain(join(dir, "app"));
    expect(finding("ENG-9")).toMatchObject({ orphan: true, verdict: CleanupVerdict.Remove, reason: CleanupReason.Orphan, blockers: [] });

    const removed = ob(["rm", "ENG-9"]);
    expect(removed.code).toBe(0);
    expect(removed.err).toContain("removed orphan ENG-9 (worktrees: app)");
    expect(existsSync(dir)).toBe(false);
    expect(registered()).not.toContain("ENG-9");
    expect(finding("ENG-9")).toBeUndefined();
  });

  test("an orphan with uncommitted changes is reviewed, refused, and removed only with --force", () => {
    const dir = orphan("dirty");
    writeFileSync(join(dir, "app", "wip.txt"), "x");
    expect(finding("dirty")).toMatchObject({ verdict: CleanupVerdict.Review, reason: CleanupReason.Orphan });
    const refused = ob(["rm", "dirty"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("orphan dirty has uncommitted changes or unpushed commits in: app");
    expect(existsSync(join(dir, "app", "wip.txt"))).toBe(true);
    expect(ob(["rm", "dirty", "--force"]).code).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  test("an orphan with a commit on no remote is refused", () => {
    const dir = orphan("ahead");
    sh(["git", "commit", "-q", "--allow-empty", "-m", "local"], join(dir, "app"));
    expect(finding("ahead")).toMatchObject({ verdict: CleanupVerdict.Review });
    expect(ob(["rm", "ahead"]).code).toBe(1);
    expect(ob(["rm", "ahead", "--force"]).code).toBe(0);
  });

  test("an orphan holding a file outside its worktrees is refused", () => {
    const dir = orphan("notes");
    writeFileSync(join(dir, "notes.md"), "keep me");
    expect(finding("notes")).toMatchObject({ verdict: CleanupVerdict.Review, strayFiles: ["notes.md"] });
    const refused = ob(["rm", "notes"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("notes.md");
    expect(ob(["rm", "notes", "--force"]).code).toBe(0);
  });

  test("a folder under the root that was never a workspace is not an orphan", () => {
    mkdirSync(join(root, "misc"));
    writeFileSync(join(root, "misc", "file"), "x");
    expect(finding("misc")).toBeUndefined();
    const refused = ob(["rm", "misc"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("no workspace 'misc'");
    expect(existsSync(join(root, "misc", "file"))).toBe(true);
  });
});

describe("cleanup on tracked workspaces", () => {
  test("detached on the default branch and clean reads as never started; the table prints it", () => {
    expect(ob(["new", "fresh", "-r", "app"]).code).toBe(0);
    expect(finding("fresh")).toMatchObject({ orphan: false, verdict: CleanupVerdict.Ask, reason: CleanupReason.NeverStarted });
    const table = ob(["cleanup", "--no-fetch", "--dry-run"]);
    expect(table.code).toBe(0);
    expect(table.out).toMatch(/fresh\s+ask\s+never-started/);
    expect(existsSync(join(root, "fresh"))).toBe(true);
  });

  test("uncommitted work keeps it", () => {
    writeFileSync(join(root, "fresh", "app", "wip.txt"), "x");
    expect(finding("fresh")).toMatchObject({ verdict: CleanupVerdict.Keep, reason: CleanupReason.InProgress });
  });
});
