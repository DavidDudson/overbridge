import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateKey, estimatesFile } from "../src/check-estimate";
import { HELD_ENV, readTickets, stopTicket } from "../src/check-queue";
import { shellQuote } from "../src/util";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let tmp: string;
let root: string;
let remote: string;

/** Without the held marker, so the suite's own checks queue when it runs inside `overbridge check`. */
const inherited = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== HELD_ENV));

const env = () => ({
  ...inherited(),
  OVERBRIDGE_ROOT: root,
  ZELLIJ_CONFIG_DIR: join(root, "zellij-config"), // keep a real user layout out of the tests
  OVERBRIDGE_NAME: "",
  OVERBRIDGE_IDE: "", // file links follow it when no ide is configured
  CLAUDECODE: "", // the suite may run inside Claude Code; this marks a caller as an agent
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
    expect(readFileSync(join(root, "ws1", "CLAUDE.md"), "utf8")).not.toContain("## File references");

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
    expect(settings.plansDirectory).toBe(".overbridge-plans");
    // the copy a Claude started in a repo folder loads with --settings
    const copy = JSON.parse(readFileSync(join(root, ".overbridge", "workspaces", "ws1.settings.json"), "utf8"));
    expect(copy).toEqual(settings);
    mkdirSync(join(root, "ws1", "app", ".overbridge-plans"), { recursive: true });
    writeFileSync(join(root, "ws1", "app", ".overbridge-plans", "p.md"), "plan\n");
    expect(Bun.spawnSync(["git", "-C", join(root, "ws1", "app"), "status", "--porcelain"]).stdout.toString()).toBe("");
    rmSync(join(root, "ws1", "app", ".overbridge-plans"), { recursive: true });
    expect(settings.permissions.allow).toContain("Bash(gh pr ready:*)");
    expect(settings.permissions.allow).toContain("Bash(gh stack push:*)");
    expect(settings.permissions.allow).not.toContain("Bash(gh pr merge:*)");
    expect(settings.autoMode.allow[0]).toBe("$defaults");
    const marketplace = settings.extraKnownMarketplaces.overbridge.source;
    expect(marketplace.source).toBe("directory");
    expect(existsSync(join(marketplace.path, ".claude-plugin", "marketplace.json"))).toBe(true);
    expect(settings.enabledPlugins).toEqual({ "overbridge@overbridge": true, "overbridge-review@overbridge": true });

    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Notification", "PermissionRequest", "SubagentStart", "SubagentStop", "PreCompact", "Stop", "SessionEnd"]) {
      expect(settings.hooks[event][0].hooks[0].command).toMatch(/ hook$/);
    }
  });

  test("CLAUDE.md's file links follow the repo's ide over the root defaults, and a bad repo layer never blocks a launch", () => {
    const config = join(root, "config.yml");

    try {
      writeFileSync(config, "defaults:\n  ide: zed\nrepos:\n  app:\n    ide: { name: vscode, github: false }\n");
      expect(ws(["new", "links", "-r", "app"]).code).toBe(0);
      const md = readFileSync(join(root, "links", "CLAUDE.md"), "utf8");
      expect(md).toContain("(vscode://file/");
      expect(md).not.toContain("zed://");
      expect(md).not.toContain("↗");
      expect(ws(["rm", "links"]).code).toBe(0);
      writeFileSync(config, "defaults:\n  ide: zed\n");
      expect(ws(["new", "links", "-r", "app"]).code).toBe(0);
      expect(readFileSync(join(root, "links", "CLAUDE.md"), "utf8")).toContain("(zed://file/abs/path/to/repo/AGENTS.md:268) [↗](");
      expect(ws(["rm", "links"]).code).toBe(0);
    } finally {
      rmSync(config, { force: true });
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

  test("rm refuses an orchestration tab, with or without --force", () => {
    for (const tab of ["@root", "@work"]) {
      for (const args of [["rm", tab], ["rm", "--force", tab], ["rm", "--background-finish", tab]]) {
        const r = ws(args);
        expect(r.code).not.toBe(0);
        expect(r.err).toContain(`${tab} is an orchestration tab`);
      }
    }
  });

  test("claude refuses the work list tab, which has no agent", () => {
    const r = ws(["claude", "@work"]);
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("not Claude");
  });

  test("worklist show prints the cache and does not need a tty", () => {
    const r = ws(["worklist", "show"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("nothing assigned to you");
  });

  test("layout opens the orchestration tabs (root, work list, PRs, reviews, performance, check queue, frozen, explore), then one tab per workspace, each with sidebar and top panel", () => {
    for (const n of ["ws3", "ws4", "ws5"]) ws(["new", n]);
    const kdl = ws(["layout"]).out;
    expect(kdl.match(/\btab name=/g)?.length).toBe(13);
    expect(kdl.indexOf('tab name="@root"')).toBeLessThan(kdl.indexOf('tab name="ws'));
    expect(kdl).toContain('"claude" "@root"');
    expect(kdl).toMatch(/args .*"worklist"/);
    expect(kdl).toContain('"claude" "ws5"');
    expect(kdl).toContain('"sidebar" "--ws" "ws5"');
    expect(kdl).toContain('"top" "--ws" "ws5"');
  });

  test("rm removes worktree and state", () => {
    expect(ws(["rm", "ws1"]).code).toBe(0);
    expect(existsSync(join(root, "ws1"))).toBe(false);
    expect(sh(["git", "worktree", "list"], join(root, ".bare", "app.git"))).not.toContain("/ws1/");
  });

  test("go takes exactly one target, and help lists it", () => {
    const r = ws(["go"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("usage: overbridge go <n>|<name>|next|prev");
    expect(ws(["go", "1", "2"]).err).toContain("usage: overbridge go");
    expect(ws(["help"]).out).toContain("overbridge go <n>|<name>|next|prev");
  });

  test("new needs a name: workspaces are named for their work, not numbered", () => {
    const r = ws(["new", "-r", "app"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("usage: overbridge new <name>");
  });

  test("rm clears per-workspace files kept outside the workspace dir", () => {
    expect(ws(["new", "gone", "-r", "app"]).code).toBe(0);
    const files = ["top/gone.json", "agent/gone.json", "agent/gone.turn.json", "context/gone.json", "sidebars/gone", "tabs/gone.kdl", "pr-view/gone/app.pr3.json"].map((f) => join(root, ".overbridge", f));

    for (const f of files) {
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, "x");
    }

    expect(ws(["rm", "gone"]).code).toBe(0);

    for (const f of files) expect(existsSync(f)).toBe(false);

    expect(existsSync(join(root, ".overbridge", "pr-view", "gone"))).toBe(false);
  });

  test("a gh-stack stack is claimed as a unit", () => {
    const bare = join(root, ".bare", "app.git");

    for (const n of ["sa", "sb"]) expect(ws(["new", n, "-r", "app"]).code).toBe(0);
    const sa = join(root, "sa", "app");
    // older gh-stack kept its catalog in git's common dir, the shared bare repo
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

  test("a gh-stack catalog kept in a worktree's own git dir still claims the stack", () => {
    const bare = join(root, ".bare", "app.git");

    for (const n of ["wa", "wb"]) expect(ws(["new", n, "-r", "app"]).code).toBe(0);
    const wa = join(root, "wa", "app");
    expect(ws(["checkout", "app", "w1"], wa).code).toBe(0);
    rmSync(join(bare, "gh-stack"), { force: true });
    const gitDir = sh(["git", "rev-parse", "--path-format=absolute", "--git-dir"], wa);
    writeFileSync(join(gitDir, "gh-stack"), JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: "main" }, branches: [{ branch: "w1" }, { branch: "w2" }] }] }));

    const steal = ws(["checkout", "app", "w2"], join(root, "wb"));
    expect(steal.code).toBe(1);
    expect(steal.err).toContain("claimed by workspace wa");
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

  test("explore sync checks out the default branch, follows it, and leaves local work alone", () => {
    const dir = join(root, "@explore", "app");
    const head = () => sh(["git", "rev-parse", "HEAD"], dir);
    const tip = () => sh(["git", "rev-parse", "main"], remote);

    expect(ws(["explore", "sync", "app"]).code).toBe(0);
    expect(head()).toBe(tip());

    const src = join(tmp, "src");
    writeFileSync(join(src, "a.txt"), "one\n");
    sh(["git", "add", "a.txt"], src);
    sh(["git", "commit", "-q", "-m", "add a"], src);
    sh(["git", "push", "-q", remote, "main"], src);
    expect(ws(["explore", "sync", "app"]).code).toBe(0);
    expect(head()).toBe(tip());

    writeFileSync(join(dir, "stray.log"), "untracked\n");
    writeFileSync(join(src, "a.txt"), "two\n");
    sh(["git", "commit", "-q", "-am", "change a"], src);
    sh(["git", "push", "-q", remote, "main"], src);
    expect(ws(["explore", "sync", "app"]).err).toBe("");
    expect(head()).toBe(tip());

    writeFileSync(join(dir, "a.txt"), "edited\n");
    const dirty = ws(["explore", "sync", "app"]);
    expect(dirty.err).toContain("has local changes");
    expect(head()).toBe(tip());
    sh(["git", "checkout", "--", "a.txt"], dir);

    writeFileSync(join(dir, "b.txt"), "mine\n");
    writeFileSync(join(src, "b.txt"), "theirs\n");
    sh(["git", "add", "b.txt"], src);
    sh(["git", "commit", "-q", "-m", "add b"], src);
    const before = head();
    sh(["git", "push", "-q", remote, "main"], src);
    expect(ws(["explore", "sync", "app"]).err).toContain("could not move to origin/main");
    expect(head()).toBe(before);
    expect(readFileSync(join(dir, "b.txt"), "utf8")).toBe("mine\n");
    rmSync(join(dir, "b.txt"));
    expect(ws(["explore", "sync", "app"]).err).toBe("");
    expect(head()).toBe(tip());

    writeFileSync(join(src, ".gitignore"), "*.local\n");
    sh(["git", "add", ".gitignore"], src);
    sh(["git", "commit", "-q", "-m", "ignore local files"], src);
    sh(["git", "push", "-q", remote, "main"], src);
    expect(ws(["explore", "sync", "app"]).err).toBe("");
    writeFileSync(join(dir, "c.local"), "mine\n");
    writeFileSync(join(src, "c.local"), "theirs\n");
    sh(["git", "add", "-f", "c.local"], src);
    sh(["git", "commit", "-q", "-m", "add c.local"], src);
    const beforeIgnored = head();
    sh(["git", "push", "-q", remote, "main"], src);
    expect(ws(["explore", "sync", "app"]).err).toContain("could not move to origin/main");
    expect(head()).toBe(beforeIgnored);
    expect(readFileSync(join(dir, "c.local"), "utf8")).toBe("mine\n");
    rmSync(join(dir, "c.local"));
    expect(ws(["explore", "sync", "app"]).err).toBe("");
    expect(head()).toBe(tip());

    sh(["git", "commit", "-q", "--allow-empty", "-m", "local"], dir);
    const local = head();
    const ahead = ws(["explore", "sync", "app"]);
    expect(ahead.err).toContain("has commits not on origin/main");
    expect(head()).toBe(local);
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

  test("with one repo the agent starts inside its shell, cwd the repo folder", () => {
    const dsa = join(root, "dsa");
    const run = launch();
    expect(run.exitCode).toBe(0);
    expect(run.stdout.toString().trim().split("\n")).toEqual(["FOO=bar", join(dsa, "app")]);
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

describe("check queue", () => {
  // the runner's own load must never hold a test at the gate, and each test spawns several CLIs
  const CHECK_TEST_MS = 20_000;
  const cq = () => join(root, "cq");
  const queue = () => join(root, ".overbridge", "check-queue");

  const config = (extra = "", skipQueueSeconds = 0) =>
    writeFileSync(join(cq(), "app", "overbridge.yml"), `shell: env FOO=queued\ncheck-queue:\n  max-load-percent: 100000\n  max-cpu-percent: 100000\n  skip-queue-seconds: ${skipQueueSeconds}\n${extra}`);

  const check = (args: string[]) => ws(["check", ...args], cq());

  /** A check runs one command, so a multi-step test command goes in a script file. */
  const script = (name: string, body: string) => {
    const file = join(tmp, `${name}.sh`);
    writeFileSync(file, body);

    return ["--", "sh", file];
  };

  const spawnCheck = (args: string[]) =>
    Bun.spawn({ cmd: [process.execPath, CLI, "check", ...args], cwd: cq(), env: env(), stdout: "pipe", stderr: "pipe" });

  /** Tickets only: a holder rewrites its ticket through a `.tmp` file, so the directory briefly holds both. */
  const tickets = () => readdirSync(queue()).filter((name) => name.endsWith(".json"));

  const waitFor = async (done: () => boolean) => {
    const deadline = Date.now() + 10_000;
    let seen = done();

    while (!seen && Date.now() < deadline) {
      await Bun.sleep(25);
      seen = done();
    }

    expect(seen).toBe(true);
  };

  test("runs in the repo's dev shell, passes the exit code through and leaves no ticket", () => {
    expect(ws(["new", "cq", "-r", "app"]).code).toBe(0);
    config();
    const r = check(script("exit3", 'echo "$FOO $OVERBRIDGE_CHECK_HELD"; exit 3'));
    expect(r.code).toBe(3);
    expect(r.out.trim()).toBe("queued 1");
    expect(tickets()).toEqual([]);
    expect(check(["app", "--", "true"]).code).toBe(0);
    expect(check(["nope", "--", "true"]).err).toContain("nope is not in cq");
    expect(check(["app"]).code).toBe(1);
    expect(check(["--timeout-seconds", "x", "--", "true"]).err).toContain("--timeout-seconds expects a whole number");
    const chained = check(["--", "sh", "-c", "true && true"]);
    expect(chained.code).toBe(1);
    expect(chained.err).toContain("overbridge check runs one command, but this script chains 2");
  }, CHECK_TEST_MS);

  test("two runs overlap while the load allows", async () => {
    config();
    const log = join(tmp, "overlap.log");
    const step = (name: string) => script(`overlap-${name}`, `echo start ${name} >> ${log}; sleep 2; echo end ${name} >> ${log}`);
    const first = spawnCheck(step("a"));
    await waitFor(() => existsSync(log));
    const second = spawnCheck(step("b"));
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    // both start before either ends; two equal sleeps started close together can end in either order
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.slice(0, 2)).toEqual(["start a", "start b"]);
    expect(lines.slice(2).toSorted()).toEqual(["end a", "end b"]);
    expect(tickets()).toEqual([]);
  }, CHECK_TEST_MS);

  test("with max-parallel 1, two runs take turns instead of overlapping", async () => {
    config("  max-parallel: 1\n");
    const log = join(tmp, "turns.log");
    const step = (name: string) => script(`turns-${name}`, `echo start ${name} >> ${log}; sleep 1; echo end ${name} >> ${log}`);
    const first = spawnCheck(step("a"));
    await waitFor(() => existsSync(log));
    const second = spawnCheck(step("b"));
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);
    const waited = await new Response(second.stderr).text();
    expect(waited).toContain("waiting behind 1 in the queue (max-parallel 1)");
    // `a` has never finished before, so nothing estimates when `b` can start
    expect(waited).not.toContain("estimated start");
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start a", "end a", "start b", "end b"]);
  }, CHECK_TEST_MS);

  test("the ticket records the workspace's class: the repo's priority, from the default classes", () => {
    config("  priority: low\n");
    const r = check(["--", "sh", "-c", `cat ${queue()}/*.json`]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim())).toMatchObject({ priority: "low", rank: 2, icon: "🔻" });
  }, CHECK_TEST_MS);

  test("a waiting check moved in order.state starts before the one queued ahead of it", async () => {
    config("  max-parallel: 1\n");
    const log = join(tmp, "moved.log");
    const step = (name: string, secs: number) => script(`moved-${name}`, `echo ${name} >> ${log}; sleep ${secs}`);
    const first = spawnCheck(step("a", 2));
    await waitFor(() => existsSync(log));
    const second = spawnCheck(step("b", 0));
    await waitFor(() => tickets().length === 2);
    const third = spawnCheck(step("c", 0));
    await waitFor(() => tickets().length === 3);
    const thirdTicket = tickets().toSorted().at(-1);
    expect(thirdTicket).toBeDefined();
    writeFileSync(join(queue(), "order.state"), JSON.stringify({ [thirdTicket ?? ""]: 0 }));
    expect([await first.exited, await second.exited, await third.exited]).toEqual([0, 0, 0]);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["a", "c", "b"]);
  }, CHECK_TEST_MS);

  test("stopTicket kills a running check, and history records it as killed", async () => {
    config();
    const marker = join(tmp, "killed.started");
    const run = spawnCheck(script("killed", `touch ${marker}; sleep 30`));
    await waitFor(() => existsSync(marker) && readTickets(queue()).some((t) => t.runPid !== undefined));
    readTickets(queue()).forEach((t) => stopTicket(t, queue()));
    expect(await run.exited).toBe(143);
    expect(tickets()).toEqual([]);
    const history = readFileSync(join(root, ".overbridge", "history", "cq.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(history.at(-1)).toMatchObject({ kind: "check", exit: 143, killed: true });
    expect(history.at(-1).runMs).toBeGreaterThan(0);
  }, CHECK_TEST_MS);

  test("a killed check that ignores TERM keeps its ticket until KILL ends its group", async () => {
    config();
    const marker = join(tmp, "stubborn.started");
    const run = spawnCheck(script("stubborn", `trap "" TERM; touch ${marker}; sleep 30`));
    await waitFor(() => existsSync(marker) && readTickets(queue()).some((t) => t.runPid !== undefined));
    readTickets(queue()).forEach((t) => stopTicket(t, queue()));
    await Bun.sleep(1_000);
    expect(tickets()).toHaveLength(1);
    expect(await run.exited).toBe(143);
    expect(tickets()).toEqual([]);
  }, CHECK_TEST_MS);

  test("a bare program runs from the nearest bin-dirs folder, and history keeps its name", () => {
    config();
    const app = join(cq(), "app");

    const bin = (dir: string, text: string) => {
      mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(dir, "node_modules", ".bin", "hello"), `#!/bin/sh\necho ${text}\n`, { mode: 0o755 });
    };

    try {
      bin(app, "root");
      bin(join(app, "sub"), "sub");
      expect(ws(["check", "app", "--", "hello"], join(app, "sub")).out.trim()).toBe("sub");
      expect(ws(["check", "app", "--", "hello"], app).out.trim()).toBe("root");
      const history = readFileSync(join(root, ".overbridge", "history", "cq.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(history.at(-1)).toMatchObject({ kind: "check", command: "hello" });
    } finally {
      rmSync(join(app, "node_modules"), { recursive: true, force: true });
      rmSync(join(app, "sub"), { recursive: true, force: true });
    }
  }, CHECK_TEST_MS);

  test("a check whose own passing runs were quick skips the queue", async () => {
    config("  max-parallel: 1\n", 10);
    const log = join(tmp, "skip.log");
    const quick = script("skip-quick", `echo quick >> ${log}`);
    const command = quick.slice(1).map(shellQuote).join(" ");
    writeFileSync(estimatesFile(join(root, ".overbridge")), JSON.stringify({ [estimateKey("app", command)]: [100, 100, 100] }));
    const slow = spawnCheck(script("skip-slow", `echo start >> ${log}; sleep 3; echo end >> ${log}`));
    await waitFor(() => existsSync(log));
    expect(check(quick).code).toBe(0);
    expect(await slow.exited).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["start", "quick", "end"]);
  }, CHECK_TEST_MS);

  test("a nested check inside a held run runs at once", () => {
    config();
    const r = check(["--", "sh", "-c", `${process.execPath} ${CLI} check -- echo nested`]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("nested");
  }, CHECK_TEST_MS);

  test("a run over its timeout is killed with 124", () => {
    const r = check(["--timeout-seconds", "1", "--", "sleep", "30"]);
    expect(r.code).toBe(124);
    expect(r.err).toContain("stopped after 1s");
  }, CHECK_TEST_MS);

  test("a run that uses no CPU for stall-seconds is killed with 137", () => {
    config("  stall-seconds: 1\n");
    const started = Date.now();
    const r = check(["--", "sleep", "30"]);
    expect(r.code).toBe(137);
    expect(r.err).toContain("used no CPU for 1s");
    expect(Date.now() - started).toBeLessThan(10_000);
  }, CHECK_TEST_MS);

  test("a waiter gives up with 75 after wait-seconds", async () => {
    config("  wait-seconds: 1\n  max-parallel: 1\n");
    const holder = spawnCheck(["--", "sleep", "3"]);
    await waitFor(() => tickets().length === 1);
    const r = check(["--", "true"]);
    expect(r.code).toBe(75);
    expect(r.err).toContain("still busy after 1s");
    expect(await holder.exited).toBe(0);
  }, CHECK_TEST_MS);

  test("a dead holder's ticket is reaped and the command it left running is killed", async () => {
    config();
    const gone = Bun.spawn({ cmd: ["true"] });
    await gone.exited;
    const orphan = Bun.spawn({ cmd: ["sleep", "30"], detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    const ticket = { pid: gone.pid, ws: "ghost", repo: "app", command: "sleep 30", queuedAtMs: 1, runPid: orphan.pid, runningSinceMs: 1 };
    writeFileSync(join(queue(), `${String(1).padStart(15, "0")}-${gone.pid}.json`), JSON.stringify(ticket));
    const r = check(["--", "echo", "after"]);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("after");
    expect(r.err).toContain("holder from ghost died");
    expect(await orphan.exited).not.toBe(0);
    expect(tickets()).toEqual([]);
  }, CHECK_TEST_MS);
});

describe("config set", () => {
  test("--repo writes under repos.<name>, and a missing value prints the usage", () => {
    const file = join(root, "config.yml");
    const r = ws(["config", "set", "ide", "zed", "--repo", "app"]);

    try {
      expect(r.code).toBe(0);
      expect(readFileSync(file, "utf8")).toBe("repos:\n  app:\n    ide: zed\n");
      const agent = Bun.spawnSync({ cmd: [process.execPath, CLI, "config", "set", "defaults.ide", "zed"], cwd: tmp, env: { ...env(), CLAUDECODE: "1", OVERBRIDGE_NAME: "ws1" }, stderr: "pipe" });
      expect(agent.exitCode).not.toBe(0);
      expect(agent.stderr.toString()).toContain("ask them to run it");
      const usage = ws(["config", "set", "defaults.ide"]);
      expect(usage.code).not.toBe(0);
      expect(usage.err).toContain("usage: overbridge config set");
    } finally {
      rmSync(file, { force: true });
    }
  });
});

describe("thaw --prompt", () => {
  test("opens the thawed tab with the handoff read first, then the request", () => {
    expect(ws(["new", "frz", "-r", "app"]).code).toBe(0);
    const bin = join(tmp, "thaw-bin");
    const layouts = join(tmp, "thaw-layouts");
    mkdirSync(bin, { recursive: true });
    // a stand-in zellij: every action succeeds, and each --layout file it is given is appended to $LAYOUTS
    writeFileSync(join(bin, "zellij"), '#!/bin/sh\nprev=""\nfor a; do [ "$prev" = "--layout" ] && cat "$a" >> "$LAYOUTS"; prev=$a; done\nexit 0\n', { mode: 0o755 });

    const inZellij = (args: string[]) =>
      Bun.spawnSync({
        cmd: [process.execPath, CLI, ...args],
        cwd: tmp,
        env: { ...env(), PATH: `${bin}:${process.env.PATH}`, TMUX: "", ZELLIJ: "0", ZELLIJ_SESSION_NAME: "t", LAYOUTS: layouts },
        stdout: "pipe",
        stderr: "pipe",
      });

    const iced = inZellij(["icebox", "frz"]);
    expect(iced.exitCode, iced.stderr.toString()).toBe(0);
    const thawed = inZellij(["thaw", "frz", "--prompt", "/pickup #7"]);
    expect(thawed.exitCode).toBe(0);
    expect(readFileSync(layouts, "utf8")).toContain("/read-handoff --then /pickup #7");
  });
});

describe("relaunch", () => {
  const bin = () => join(tmp, "rl-bin");
  const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  const launcherFile = (name: string) => join(root, ".overbridge", "agent", `${name}.launcher.json`);
  const launcherChild = (name: string): number | undefined => (existsSync(launcherFile(name)) ? JSON.parse(readFileSync(launcherFile(name), "utf8")).child : undefined);

  const until = async (done: () => boolean) => {
    const deadline = Date.now() + 10_000;

    while (!done() && Date.now() < deadline) await Bun.sleep(50);
  };

  /** A fake claude that logs each start to `runs`, runs `overbridge <ACTION>` once when ACTION is set, then idles. */
  beforeAll(() => {
    mkdirSync(bin(), { recursive: true });
    writeFileSync(
      join(bin(), "claude"),
      [
        "#!/bin/sh",
        'echo "CM=${CLAUDE_CODE_EXPERIMENTAL_CODE_MODE-unset} NAME=$OVERBRIDGE_NAME ARGS=$*" >> "$RUNS"',
        'if [ -n "$ACTION" ] && [ ! -e "$RUNS.acted" ]; then touch "$RUNS.acted"; "$BUN" "$CLI" $ACTION > "$RUNS.out" 2>&1; echo "exit=$?" >> "$RUNS.out"; fi',
        'if [ -n "$WRAP" ]; then sleep 30 & echo $! >> "$RUNS.pids"; wait; else exec sleep 30; fi',
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    // the same fake stands in for agy, so an agy workspace's argv lands in `runs` too
    copyFileSync(join(bin(), "claude"), join(bin(), "agy"));
  });

  const supervise = (name: string, extra: Record<string, string> = {}, args: string[] = []) => {
    const runs = join(tmp, `${name}-runs`);

    const p = Bun.spawn({
      cmd: [process.execPath, CLI, "claude", name, ...args],
      cwd: tmp,
      env: { ...env(), CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "1", PATH: `${bin()}:${process.env.PATH}`, RUNS: runs, BUN: process.execPath, CLI, ...extra },
      stdout: "pipe",
      stderr: "pipe",
    });

    return { p, runs };
  };

  const stop = async (name: string, p: Bun.Subprocess) => {
    p.kill("SIGTERM");
    await p.exited;
    expect(existsSync(launcherFile(name))).toBe(false);
  };

  test("restarts the agent in place with the new env and args, resuming on /read-handoff", async () => {
    expect(ws(["new", "rl"]).code).toBe(0);
    const { p, runs } = supervise("rl");
    await until(() => lines(runs).length === 1 && launcherChild("rl") !== undefined);
    const first = launcherChild("rl");

    writeFileSync(join(root, "config.yml"), "agent-launch:\n  claude:\n    args: [--model, m]\n");
    // a piped caller is not a terminal, so it may set only the shorthands
    expect(ws(["relaunch", "rl", "--", "--permission-mode", "plan"]).err).toContain("in a terminal");
    const r = ws(["relaunch", "rl", "--no-code-mode", "--chrome"]);
    expect(r.err).toBe("");
    expect(r.out).toContain("handoff at");
    await until(() => lines(runs).length === 2 && launcherChild("rl") !== undefined && launcherChild("rl") !== first);

    const [before, after] = lines(runs);
    // the caller's env reaches the agent, and the relaunch's own setting wins over it
    expect(before).toStartWith("CM=1 NAME=rl ARGS=--settings");
    expect(after).toStartWith("CM=0 NAME=rl ARGS=--settings");
    // root config args first, then the workspace's own
    expect(after).toEndWith("--model m --chrome --continue -- /read-handoff");
    expect(readdirSync(join(root, "rl", ".overbridge", "handoffs")).some((f) => f.endsWith("-relaunch.md"))).toBe(true);

    rmSync(join(root, "config.yml"));
    const fresh = ws(["relaunch", "rl", "--fresh", "--prompt", "x"]);
    expect(fresh.code).toBe(0);
    await until(() => lines(runs).length === 3);
    expect(lines(runs)[2]).toStartWith("CM=1 NAME=rl");
    expect(lines(runs)[2]).toEndWith("--name rl -- /read-handoff --then x");

    expect(ws(["relaunch", "rl", "--env", "OVERBRIDGE_NAME=other"]).err).toContain("OVERBRIDGE_* variables are set by overbridge");
    await stop("rl", p);
  }, 30_000);

  test("overbridge model restarts the agent on the model, keeps its other settings, and an agent may run it", async () => {
    expect(ws(["new", "md"]).code).toBe(0);
    const { p, runs } = supervise("md", { ACTION: "model md opus" });
    await until(() => lines(runs).length === 2);
    expect(lines(runs)[1]).toContain("--model opus --continue -- /read-handoff");
    expect(ws(["model", "md"]).out.trim()).toBe("opus");

    expect(ws(["model", "md", "--x"]).code).not.toBe(0);
    await stop("md", p);
  }, 30_000);

  test("an agy workspace opened with a prompt gets it as -i, never as a bare argument", async () => {
    expect(ws(["new", "ag", "--agent", "agy"]).code).toBe(0);
    // the argv a new tab runs: overbridge claude's own `--`, then the prompt after the agent's `--`
    const { p, runs } = supervise("ag", {}, ["--", "--", "/start-item 12"]);
    await until(() => lines(runs).length === 1);
    expect(lines(runs)[0]).toEndWith("ARGS=-i /start-item 12");
    await stop("ag", p);
  }, 30_000);

  test("an agent may relaunch its own workspace with the shorthands, but not another workspace", async () => {
    expect(ws(["new", "rl2"]).code).toBe(0);
    expect(ws(["new", "rl3"]).code).toBe(0);
    const target = supervise("rl3");
    await until(() => launcherChild("rl3") !== undefined);
    const other = supervise("rl2", { ACTION: "relaunch rl3 --chrome" });
    await until(() => lines(`${other.runs}.out`).some((l) => l.startsWith("exit=")));
    expect(lines(`${other.runs}.out`).join("\n")).toContain("an agent can relaunch only its own workspace (rl2), not rl3");
    expect(lines(target.runs)).toHaveLength(1);

    expect(ws(["new", "rl4"]).code).toBe(0);
    const self = supervise("rl4", { ACTION: "relaunch rl4 --chrome" });
    await until(() => lines(self.runs).length === 2);
    expect(lines(self.runs)[1]).toContain("--chrome --continue -- /read-handoff");

    await Promise.all([stop("rl2", other.p), stop("rl3", target.p), stop("rl4", self.p)]);
  }, 30_000);
  test("a relaunch stops the whole process tree under a wrapper before starting again", async () => {
    expect(ws(["new", "rl5"]).code).toBe(0);
    const { p, runs } = supervise("rl5", { WRAP: "1" });
    await until(() => lines(`${runs}.pids`).length === 1);
    const [grandchild] = lines(`${runs}.pids`).map(Number);

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);

        return true;
      } catch {
        return false;
      }
    };

    expect(alive(grandchild!)).toBe(true);
    expect(ws(["relaunch", "rl5", "--chrome"]).code).toBe(0);
    await until(() => lines(runs).length === 2);
    expect(alive(grandchild!)).toBe(false);

    const [, second] = lines(`${runs}.pids`).map(Number);
    await stop("rl5", p);
    await until(() => !alive(second!));
    expect(alive(second!)).toBe(false);
  }, 30_000);
});
