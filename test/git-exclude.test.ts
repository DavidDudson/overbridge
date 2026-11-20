import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { excludeInRepo } from "../src/git";

const PATTERN = "/.overbridge-plans/";
let tmp: string;

const git = (args: string[], cwd: string) => {
  const p = Bun.spawnSync({ cmd: ["git", ...args], cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" });

  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  }

  return p.stdout.toString();
};

const excludeFile = (repo: string) => join(repo, ".git", "info", "exclude");

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ob-exclude-")));
});

afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe("excludeInRepo", () => {
  test("adds the pattern once, however often it runs", () => {
    const repo = join(tmp, "repo");
    git(["init", "-q", repo], tmp);
    excludeInRepo(repo, PATTERN);
    excludeInRepo(repo, PATTERN);
    expect(readFileSync(excludeFile(repo), "utf8").split("\n").filter((l) => l === PATTERN)).toHaveLength(1);
  });

  test("starts a new line after an unterminated last line, and accepts a line with trailing space", () => {
    const repo = join(tmp, "repo");
    git(["init", "-q", repo], tmp);
    writeFileSync(excludeFile(repo), "foo");
    excludeInRepo(repo, PATTERN);
    expect(readFileSync(excludeFile(repo), "utf8")).toBe(`foo\n${PATTERN}\n`);

    writeFileSync(excludeFile(repo), `${PATTERN} \r\n`);
    excludeInRepo(repo, PATTERN);
    expect(readFileSync(excludeFile(repo), "utf8")).toBe(`${PATTERN} \r\n`);
  });

  test("a linked worktree writes the exclude its repo shares, so plans stay out of git status", () => {
    const repo = join(tmp, "repo");
    git(["init", "-q", "-b", "main", repo], tmp);
    git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"], repo);
    const wt = join(tmp, "wt");
    git(["worktree", "add", "-q", "--detach", wt], repo);
    excludeInRepo(wt, PATTERN);
    expect(readFileSync(excludeFile(repo), "utf8")).toContain(PATTERN);
    mkdirSync(join(wt, ".overbridge-plans"));
    writeFileSync(join(wt, ".overbridge-plans", "p.md"), "plan");
    expect(git(["status", "--porcelain"], wt)).toBe("");
  });

  test("leaves an enclosing repo alone when the folder is not a worktree root", () => {
    git(["init", "-q", tmp], tmp);
    const inner = join(tmp, "inner");
    mkdirSync(inner);
    const before = existsSync(excludeFile(tmp)) ? readFileSync(excludeFile(tmp), "utf8") : "";
    excludeInRepo(inner, PATTERN);
    excludeInRepo(join(tmp, "missing"), PATTERN);
    expect(existsSync(excludeFile(tmp)) ? readFileSync(excludeFile(tmp), "utf8") : "").toBe(before);
  });
});
