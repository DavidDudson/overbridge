import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { containedInPrHead } from "../src/git";

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
let tmp: string;
let origin: string;
let wt: string;

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync({ cmd: ["git", ...args], cwd, env: ENV, stdout: "pipe", stderr: "pipe" });

  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);

  return p.stdout.toString().trim();
}

const commit = (dir: string, file: string, body: string) => {
  Bun.write(join(dir, file), body);
  git(dir, "add", file);
  git(dir, "commit", "-q", "-m", `${file} ${body}`);

  return git(dir, "rev-parse", "HEAD");
};

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ob-contained-")));
  origin = join(tmp, "origin");
  wt = join(tmp, "wt");
  git(tmp, "init", "-q", "-b", "main", origin);
  commit(origin, "base", "1");
  git(origin, "checkout", "-q", "-b", "feat");
  git(tmp, "clone", "-q", origin, wt);
  git(wt, "checkout", "-q", "feat");
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("containedInPrHead", () => {
  test("HEAD is the PR head", () => {
    expect(containedInPrHead(wt, git(wt, "rev-parse", "HEAD"))).toBe(true);
  });

  test("HEAD is an ancestor of a PR head the worktree does not have yet (fetched from origin)", () => {
    const pr = commit(origin, "bot", "fix");
    expect(containedInPrHead(wt, pr)).toBe(true);
  });

  test("HEAD holds a commit the PR head lacks", () => {
    const pr = git(origin, "rev-parse", "HEAD");
    commit(wt, "local", "only");
    expect(containedInPrHead(wt, pr)).toBe(false);
  });

  test("an unfetchable PR head fails safe", () => {
    expect(containedInPrHead(wt, "0123456789012345678901234567890123456789")).toBe(false);
  });
});
