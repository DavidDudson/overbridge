import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let tmp: string;
let root: string;
let remote: string;

const env = () => ({
  ...process.env,
  OVERBRIDGE_ROOT: root,
  ZELLIJ_CONFIG_DIR: join(root, "zellij-config"), // keep a real user layout out of the tests
  OVERBRIDGE_NAME: "",
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
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "ws-test-")));
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
    expect(ws(["new", "ws1", "-r", "app"]).out.trim()).toBe("ws1");
    expect(readFileSync(join(root, "ws1", "CLAUDE.md"), "utf8")).toContain("No cache yet");
    const repos = [
      { name: "zeta", url: "https://github.com/u/zeta", isFork: true },
      { name: "Alpha", url: "https://github.com/u/Alpha", isArchived: true },
    ];
    mkdirSync(join(tmp, "cache", "overbridge"), { recursive: true });
    writeFileSync(join(tmp, "cache", "overbridge", "github-repos.json"), JSON.stringify(repos));
    expect(ws(["new", "ws2", "-r", "app"]).out.trim()).toBe("ws2");
    expect(readFileSync(join(root, "ws2", "CLAUDE.md"), "utf8")).toContain(
      "| Alpha | https://github.com/u/Alpha | archived |\n| zeta | https://github.com/u/zeta | fork |",
    );
    expect(existsSync(join(root, "ws1", "app", ".git"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(root, "ws1", ".claude", "settings.json"), "utf8"));
    expect(settings.env.OVERBRIDGE_NAME).toBe("ws1");
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toContain("guard");
    expect(settings.plansDirectory).toBe("plans");
    expect(settings.permissions.allow).toContain("Bash(gh pr ready:*)");
    expect(settings.permissions.allow).toContain("Bash(gh stack push:*)");
    expect(settings.permissions.allow).not.toContain("Bash(gh pr merge:*)");
    expect(settings.autoMode.allow[0]).toBe("$defaults");
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Notification", "PreCompact", "Stop", "SessionEnd"]) {
      expect(settings.hooks[event][0].hooks[0].command).toMatch(/ hook$/);
    }
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

  test("layout opens the root orchestration tab, then one tab per workspace, each with sidebar and top panel", () => {
    for (const n of ["ws3", "ws4", "ws5"]) ws(["new", n]);
    const kdl = ws(["layout"]).out;
    expect(kdl.match(/\btab name=/g)?.length).toBe(6);
    expect(kdl.indexOf('tab name="@root"')).toBeLessThan(kdl.indexOf('tab name="ws'));
    expect(kdl).toContain('"claude" "@root"');
    expect(kdl).toContain('"claude" "ws5"');
    expect(kdl).toContain('"sidebar" "--ws" "ws5"');
    expect(kdl).toContain('"top" "--ws" "ws5"');
  });

  test("rm removes worktree and state", () => {
    expect(ws(["rm", "ws1"]).code).toBe(0);
    expect(existsSync(join(root, "ws1"))).toBe(false);
    expect(sh(["git", "worktree", "list"], join(root, ".bare", "app.git"))).not.toContain("/ws1/");
  });

  test("new needs a name: workspaces are named for their work, not numbered", () => {
    const r = ws(["new", "-r", "app"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("usage: overbridge new <name>");
  });

  test("rm clears per-workspace files kept outside the workspace dir", () => {
    expect(ws(["new", "gone", "-r", "app"]).code).toBe(0);
    const files = ["top/gone.json", "agent/gone.json", "sidebars/gone", "tabs/gone.kdl"].map((f) => join(root, ".overbridge", f));
    for (const f of files) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, "x");
    }
    expect(ws(["rm", "gone"]).code).toBe(0);
    for (const f of files) expect(existsSync(f)).toBe(false);
  });

  test("a gh-stack stack is claimed as a unit", () => {
    const bare = join(root, ".bare", "app.git");
    for (const n of ["sa", "sb"]) expect(ws(["new", n, "-r", "app"]).code).toBe(0);
    const sa = join(root, "sa", "app");
    // gh-stack keeps its catalog in git's common dir: the shared bare repo.
    expect(sh(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], sa)).toBe(bare);
    expect(ws(["checkout", "app", "s1"], sa).code).toBe(0);
    const layer = (branch: string, pr?: number) => ({ branch, ...(pr && { pullRequest: { number: pr } }) });
    writeFileSync(
      join(bare, "gh-stack"),
      JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: "main" }, branches: [layer("s1"), layer("s2", 77)] }] }),
    );

    const steal = ws(["checkout", "app", "s2"], join(root, "sb"));
    expect(steal.code).toBe(1);
    expect(steal.err).toContain("claimed by workspace sa");

    // `gh stack add s2` moves HEAD up the stack; `overbridge pr` moves the claim with it.
    sh(["git", "switch", "-q", "-c", "s2"], sa);
    expect(ws(["pr", "app"], sa).code).toBe(0);
    const row = JSON.parse(ws(["status", "--json"], sa).out)[0];
    expect([row.branch, row.head, row.stack.layers.length]).toEqual(["s2", "s2", 2]);
    expect(ws(["status"], sa).out).toContain("local 2/2");

    expect(ws(["checkout", "app", "s1"], join(root, "sb")).code).toBe(1);
    expect(ws(["release", "app"], sa).code).toBe(0);
    expect(ws(["checkout", "app", "s1"], join(root, "sb")).code).toBe(0);
  });

  test("two branch names for one issue clash", () => {
    for (const n of ["ia", "ib"]) expect(ws(["new", n, "-r", "app"]).code).toBe(0);
    expect(ws(["checkout", "app", "fix/383-iwr-rule-elements"], join(root, "ia")).code).toBe(0);

    const twin = ws(["checkout", "app", "fix/383-defences"], join(root, "ib"));
    expect(twin.code).toBe(1);
    expect(twin.err).toContain("claimed by workspace ia");

    // Another issue, or a branch with no issue number, is free.
    expect(ws(["checkout", "app", "fix/384-defences-panel"], join(root, "ib")).code).toBe(0);
    expect(ws(["release", "app"], join(root, "ia")).code).toBe(0);
    expect(ws(["checkout", "app", "fix/383-defences"], join(root, "ib")).code).toBe(0);
  });
});

describe("dev shells", () => {
  const count = () => (existsSync(join(tmp, "count")) ? readFileSync(join(tmp, "count"), "utf8").split("\n").filter(Boolean).length : 0);
  const shell = (args: string[], cwd?: string) => ws(["shell", "app", ...args], cwd);
  const launch = () => {
    const bin = join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "claude"), '#!/bin/sh\necho "FOO=$FOO"\npwd\n', { mode: 0o755 });
    return Bun.spawnSync({
      cmd: [process.execPath, CLI, "claude", "dsa"],
      cwd: tmp,
      env: { ...env(), PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
  };

  test("overbridge shell runs in the dev shell, caches its env, and invalidates on the key files", () => {
    expect(ws(["new", "dsa", "-r", "app"]).code).toBe(0);
    const dsa = join(root, "dsa");
    const app = join(dsa, "app");

    // no shell key: the command runs as it is
    expect(shell(["--", "sh", "-c", "echo ${FOO-unset}"], dsa).out.trim()).toBe("unset");

    writeFileSync(join(app, "flake.lock"), "1");
    writeFileSync(
      join(app, "overbridge.yml"),
      `shell:\n  enter: env FOO=prefix\n  env: 'echo x >> ${join(tmp, "count")}; FOO=bar env -0'\n  key: [flake.lock]\n`,
    );
    const first = shell(["--", "sh", "-c", "echo $FOO; pwd"], dsa);
    expect(first.code).toBe(0);
    expect(first.out.trim().split("\n")).toEqual(["bar", app]);
    expect(count()).toBe(1);

    expect(shell(["--", "sh", "-c", "echo $FOO"], dsa).out.trim()).toBe("bar");
    expect(count()).toBe(1);

    writeFileSync(join(app, "flake.lock"), "2");
    shell(["--", "true"], dsa);
    expect(count()).toBe(2);

    expect(shell(["--", "sh", "-c", "exit 3"], dsa).code).toBe(3);
    // a child's own flags are not parsed as overbridge's
    expect(shell(["--", "sh", "-c", "echo $0 $1", "--flag", "x"], dsa).out.trim()).toBe("--flag x");
    expect(ws(["shell", "app"], dsa).code).toBe(1);
    expect(ws(["shell", "nope", "--", "true"], dsa).err).toContain("nope is not in dsa");
  });

  test("with one repo the agent starts inside its shell, cwd the workspace root", () => {
    const dsa = join(root, "dsa");
    const run = launch();
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim().split("\n")).toEqual(["FOO=bar", dsa]);
    expect(readFileSync(join(root, ".overbridge", "agent", "dsa.shell"), "utf8")).toBe("app");
    expect(readFileSync(join(dsa, "CLAUDE.md"), "utf8")).not.toContain("## Dev shells");
  });

  test("adding a second repo warns that the first shell leaks, and overbridge shell still works for it", () => {
    expect(ws(["repo", "add", "lib", remote]).code).toBe(0);
    const dsa = join(root, "dsa");
    const add = ws(["add", "lib"], dsa);
    expect(add.code).toBe(0);
    expect(add.err).toContain("runs inside app's dev shell");
    expect(add.err).toContain("overbridge shell lib");

    const md = readFileSync(join(dsa, "CLAUDE.md"), "utf8");
    expect(md).toContain("## Dev shells");
    expect(md).toContain("Repos with a dev shell: app.");

    writeFileSync(join(dsa, "lib", "overbridge.yml"), "shell: env FOO=lib\n");
    expect(ws(["shell", "lib", "--", "sh", "-c", "echo $FOO"], dsa).out.trim()).toBe("lib");
    expect(shell(["--", "sh", "-c", "echo $FOO"], dsa).out.trim()).toBe("bar");
  });

  test("with several repos the agent starts plain and the marker is cleared", () => {
    const run = launch();
    expect(run.stdout.toString().split("\n")[0]).toBe("FOO=");
    expect(existsSync(join(root, ".overbridge", "agent", "dsa.shell"))).toBe(false);
  });
});
