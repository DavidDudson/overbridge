import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let tmp: string;
let root: string;
let remote: string;

const env = () => ({
  ...process.env,
  WS_ROOT: root,
  WS_NAME: "",
  XDG_CACHE_HOME: join(tmp, "cache"),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

function ws(args: string[], cwd = tmp) {
  const p = Bun.spawnSync({ cmd: [process.execPath, CLI, ...args], cwd, env: env(), stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

function sh(cmd: string[], cwd: string) {
  const p = Bun.spawnSync({ cmd, cwd, env: env(), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "ws-test-"));
  root = join(tmp, "workspaces");
  const src = join(tmp, "src");
  sh(["git", "init", "-q", "-b", "main", src], tmp);
  sh(["git", "commit", "-q", "--allow-empty", "-m", "init"], src);
  sh(["git", "branch", "existing"], src);
  remote = join(tmp, "remote.git");
  sh(["git", "clone", "-q", "--bare", src, remote], tmp);
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("workflow", () => {
  test("init + repo add", () => {
    expect(ws(["init"]).code).toBe(0);
    const r = ws(["repo", "add", "app", remote]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(root, "repos.toml"), "utf8")).toContain("[repos.app]");
    expect(existsSync(join(root, ".bare", "app.git"))).toBe(true);
    expect(ws(["repo", "add", "app", remote]).code).toBe(1);
  });

  test("new workspaces get worktrees and claude scaffolding", () => {
    expect(ws(["new", "-r", "app"]).out.trim()).toBe("ws1");
    expect(readFileSync(join(root, "ws1", "CLAUDE.md"), "utf8")).toContain("No cache yet");
    const repos = [
      { name: "zeta", url: "https://github.com/u/zeta", isFork: true },
      { name: "Alpha", url: "https://github.com/u/Alpha", isArchived: true },
    ];
    mkdirSync(join(tmp, "cache", "ws"), { recursive: true });
    writeFileSync(join(tmp, "cache", "ws", "github-repos.json"), JSON.stringify(repos));
    expect(ws(["new", "-r", "app"]).out.trim()).toBe("ws2");
    expect(readFileSync(join(root, "ws2", "CLAUDE.md"), "utf8")).toContain(
      "| Alpha | https://github.com/u/Alpha | archived |\n| zeta | https://github.com/u/zeta | fork |",
    );
    expect(existsSync(join(root, "ws1", "app", ".git"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(root, "ws1", ".claude", "settings.json"), "utf8"));
    expect(settings.env.WS_NAME).toBe("ws1");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("guard");
  });

  test("checkout claims, other workspace cannot steal", () => {
    const r = ws(["checkout", "app", "feat"], join(root, "ws1", "app"));
    expect(r.code).toBe(0);
    expect(sh(["git", "branch", "--show-current"], join(root, "ws1", "app"))).toBe("feat");

    const steal = ws(["checkout", "feat"], join(root, "ws2"));
    expect(steal.code).toBe(1);
    expect(steal.err).toContain("claimed by workspace ws1");

    expect(ws(["checkout", "existing"], join(root, "ws2")).code).toBe(0);
    expect(sh(["git", "rev-parse", "--abbrev-ref", "@{u}"], join(root, "ws2", "app"))).toBe("origin/existing");
  });

  test("status reflects claims", () => {
    const rows = JSON.parse(ws(["status", "--all", "--json"]).out);
    expect(rows.map((r: any) => [r.ws, r.branch, r.head])).toEqual([
      ["ws1", "feat", "feat"],
      ["ws2", "existing", "existing"],
    ]);
  });

  test("release frees the branch", () => {
    expect(ws(["release", "--ws", "ws1"]).code).toBe(0);
    expect(ws(["checkout", "app", "feat", "--ws", "ws2"]).code).toBe(0);
    expect(sh(["git", "branch", "--show-current"], join(root, "ws2", "app"))).toBe("feat");
  });

  test("checkout adds a repo the workspace does not have yet", () => {
    expect(ws(["new", "empty"]).code).toBe(0);
    expect(ws(["checkout", "app", "other"], join(root, "empty")).code).toBe(0);
    expect(sh(["git", "branch", "--show-current"], join(root, "empty", "app"))).toBe("other");
    expect(ws(["rm", "empty"]).code).toBe(0);
  });

  test("layout has one tab per 4 workspaces", () => {
    for (let i = 0; i < 3; i++) ws(["new"]);
    const kdl = ws(["layout"]).out;
    expect(kdl.match(/\btab name=/g)?.length).toBe(2);
    expect(kdl).toContain('"claude" "ws5"');
  });

  test("rm removes worktree and state", () => {
    expect(ws(["rm", "ws1"]).code).toBe(0);
    expect(existsSync(join(root, "ws1"))).toBe(false);
    expect(sh(["git", "worktree", "list"], join(root, ".bare", "app.git"))).not.toContain("/ws1/");
  });
});
