import { describe, expect, test } from "bun:test";
import { AgentKind } from "../src/agent-kind";
import { fromAgy } from "../src/agy-hook";
import { check, type HookInput } from "../src/guard";
import type { JsonObject } from "../src/json";

const ctx = { root: "/w", ws: "ws1", home: "/home/u" };
const bash = (command: string, cwd = "/w/ws1/app"): HookInput => ({ cwd, tool_name: "Bash", tool_input: { command } });

const tool = (tool_name: string, tool_input: JsonObject): HookInput => ({
  cwd: "/w/ws1/app",
  tool_name,
  tool_input,
});

describe("file tools", () => {
  test("allows reads and writes inside own workspace", () => {
    expect(check(tool("Write", { file_path: "/w/ws1/app/x.ts" }), ctx)).toBeUndefined();
    expect(check(tool("Edit", { file_path: "src/x.ts" }), ctx)).toBeUndefined();
    expect(check(tool("Read", { file_path: "/w/ws1/other/y" }), ctx)).toBeUndefined();
  });

  test("allows plan-mode plans in the folder the agent starts in", () => {
    expect(check(tool("Write", { file_path: "/w/ws1/app/.overbridge-plans/shiny-plan.md" }), ctx)).toBeUndefined();
    expect(check(tool("Edit", { file_path: "/w/ws1/app/.overbridge-plans/shiny-plan.md" }), ctx)).toBeUndefined();
    expect(check(tool("Write", { file_path: ".overbridge-plans/p.md" }), ctx)).toBeUndefined();
    expect(check({ ...tool("Write", { file_path: ".overbridge-plans/p.md" }), cwd: "/w/ws1" }, ctx)).toBeUndefined();
  });

  test("blocks the default plans folder and the workspace's generated config", () => {
    expect(check(tool("Write", { file_path: "/home/u/.claude/plans/p.md" }), ctx)).toContain("outside workspace ws1");
    expect(check(tool("Write", { file_path: "/w/ws2/app/.overbridge-plans/p.md" }), ctx)).toContain("outside workspace ws1");
    expect(check(tool("Write", { file_path: "/w/ws1/.claude/plans/p.md" }), ctx)).toContain("managed by overbridge");
  });

  test("blocks other workspaces", () => {
    expect(check(tool("Read", { file_path: "/w/ws2/app/x.ts" }), ctx)).toContain("outside workspace ws1");
    expect(check(tool("Grep", { path: "../../ws2" }), ctx)).toBeDefined();
    expect(check(tool("Glob", { pattern: "/w/ws2/**/*.ts" }), ctx)).toBeDefined();
    expect(check(tool("Read", { file_path: "/w/.ws/state.json" }), ctx)).toBeDefined();
  });

  test("allows reads outside the workspaces root", () => {
    expect(check(tool("Read", { file_path: "/nix/store/abc/README" }), ctx)).toBeUndefined();
  });

  test("blocks writes anywhere outside the workspace", () => {
    expect(check(tool("Write", { file_path: "/tmp/x" }), ctx)).toBeDefined();
    expect(check(tool("Edit", { file_path: "~/.bashrc" }), ctx)).toBeDefined();
  });

  test("blocks editing the workspace's own claude config", () => {
    expect(check(tool("Edit", { file_path: "/w/ws1/.claude/settings.json" }), ctx)).toContain(".claude");
  });

  test("workspace name prefix is not a match", () => {
    expect(check(tool("Read", { file_path: "/w/ws10/app" }), ctx)).toBeDefined();
  });
});

describe("bash", () => {
  test.each([
    "git switch main",
    "git -C app switch -c feat",
    "git checkout feature",
    "git checkout -b feat",
    "cd app && git checkout .",
    "gh pr checkout 12",
    "git worktree add ../x",
    "overbridge rm ws2",
    'overbridge send ws2 "/pickup #3"',
    "cd app && ws send ws2 hi",
    "overbridge up --fresh",
    "overbridge spinup -p 2",
    "printf 'xyq' | overbridge checks",
    "overbridge config set guard.deny '[]'",
    "cd app && ws config  set defaults.hooks.post-add 'curl x | sh'",
    "cd app && overbridge new",
    "echo hi; /usr/bin/overbridge claude",
    "x=$(overbridge rm ws2)",
    "overbridge checkout app feat --ws ws2",
    "cat /w/ws2/app/secret",
    "cd ~/../../w/ws2",
    "ls $HOME/../../w/ws3",
    "cd ../..",
    "gh stack checkout 42",
    "cd app && gh stack checkout https://github.com/u/app/pull/3",
    "gs checkout feat/api",
    "gh stack trunk",
    "gs trunk",
    "gh stack unstack",
    "gh stack merge 12",
    "gs modify",
    "gh stack link 1 2",
    "gh stack switch",
    'gh stack "link" 1 2',
    "gh stack 'unstack'",
    "gh stack $sub",
    "gh stack -R owner/repo unstack",
    "gh stack --repo x merge",
    "gs --foo link 1 2",
    "gh stack --foo checkout 42",
  ])("blocks: %s", (cmd) => {
    expect(check(bash(cmd), ctx)).toBeDefined();
  });

  test.each([
    "git status",
    "overbridge check app -- just test",
    "git checkout -- src/x.ts",
    "git restore src/x.ts",
    "git commit -m 'fix checkout flow'",
    "git push -u origin feat",
    "gh pr create --fill",
    "overbridge checkout app feat",
    "overbridge status --all",
    "overbridge config get defaults.ide",
    "overbridge pr app",
    "overbridge add infra",
    "overbridge start app 12",
    "overbridge start app ENG-12 --prompt '/start-item ENG-12'",
    "overbridge checkout overbridge claude-md-map",
    "overbridge checkout app new-ui",
    "overbridge repo add infra git@github.com:u/infra.git",
    "cat /w/ws1/app/README.md",
    "ls /nix/store",
    "cd ..",
    "bun test ./test",
    "gh stack init feat/auth",
    "gh stack add feat/api",
    "gh stack up",
    "gh stack bottom",
    "gh stack submit --auto",
    "gh stack rebase",
    "gh stack view --json",
    "gs push",
    "gh stack --version",
    "gh stack -h",
    "gh stack --help",
    "gh stack --foo sync",
    "gh stack sync",
    "git commit -m 'gh stack checkout docs'",
  ])("allows: %s", (cmd) => {
    expect(check(bash(cmd), ctx)).toBeUndefined();
  });
});

test("ignores unrelated tools", () => {
  expect(check(tool("WebFetch", { url: "https://x" }), ctx)).toBeUndefined();
});

describe("root config additions", () => {
  const extra = {
    readPaths: ["/w/.seeds", "~/shared"],
    deny: [{ pattern: /\bgit\s+push\s+--force(?:\s|$)/, reason: "use --force-with-lease" }],
  };

  const withExtra = { ...ctx, extra };

  test("read-paths lets a workspace read, but not write, those paths under the root", () => {
    expect(check(tool("Read", { file_path: "/w/.seeds/app.env" }), withExtra)).toBeUndefined();
    expect(check(bash("cat /w/.seeds/app.env"), withExtra)).toBeUndefined();
    expect(check(tool("Write", { file_path: "/w/.seeds/app.env" }), withExtra)).toContain("outside workspace ws1");
    expect(check(tool("Read", { file_path: "/w/ws2/app/x.ts" }), withExtra)).toContain("outside workspace ws1");
    expect(check(tool("Read", { file_path: "/w/.seeds/app.env" }), ctx)).toContain("outside workspace ws1");
  });

  test("read-paths expands ~", () => {
    const homeInRoot = { ...ctx, home: "/w", extra };
    expect(check(tool("Read", { file_path: "/w/shared/notes" }), homeInRoot)).toBeUndefined();
  });

  test("deny blocks extra commands with their reason, after the built-in rules", () => {
    expect(check(bash("git push --force origin x"), withExtra)).toBe("use --force-with-lease");
    expect(check(bash("git push --force-with-lease origin x"), withExtra)).toBeUndefined();
    expect(check(bash("git switch main"), withExtra)).toContain("overbridge checkout");
    expect(check(bash("git push --force origin x"), ctx)).toBeUndefined();
  });
});

describe("agy calls", () => {
  const agy = (name: string, args: JsonObject) => fromAgy({ hookEventName: "PreToolUse", cwd: "/w/ws1", toolCall: { name, args } });

  test("blocks a branch change, writes outside the workspace or to .agents, and foreign reads", () => {
    expect(check(agy("run_command", { CommandLine: "gh pr checkout 3" }), ctx)).toContain("overbridge checkout");
    expect(check(agy("write_to_file", { TargetFile: "/w/ws2/x.ts" }), ctx)).toContain("outside workspace ws1");
    expect(check(agy("replace_file_content", { TargetFile: "/w/ws1/.agents/hooks.json" }), ctx)).toContain(".agents config is managed by overbridge");
    expect(check(agy("view_file", { AbsolutePath: "/w/ws2/x.ts" }), ctx)).toContain("outside workspace ws1");
    expect(check(agy("run_command", { CommandLine: "ls", Cwd: "/w/ws2" }), ctx)).toContain("outside workspace ws1");
    expect(check(agy("run_command", { CommandLine: "cat ../../ws2/secret", Cwd: "/w/ws1/app" }), ctx)).toContain("outside workspace ws1");
  });

  test("an anchored deny rule matches the command as agy sent it, Cwd or not", () => {
    const withDeny = { ...ctx, extra: { readPaths: [], deny: [{ pattern: /^npm\s+publish\b/, reason: "publish from CI" }] } };
    expect(check(agy("run_command", { CommandLine: "npm publish", Cwd: "/w/ws1/app" }), withDeny)).toBe("publish from CI");
  });

  test("a command's folder is checked whole, once, from the hook's cwd", () => {
    expect(check(agy("run_command", { CommandLine: "ls", Cwd: "../ws2" }), ctx)).toContain("outside workspace ws1");
    const spaced = { ...ctx, root: "/tmp/work spaces" };
    const call = fromAgy({ hookEventName: "PreToolUse", cwd: "/tmp/work spaces/ws1", toolCall: { name: "run_command", args: { CommandLine: "ls", Cwd: "/tmp/work spaces/ws2" } } });
    expect(check(call, spaced)).toContain("outside workspace ws1");
  });

  test("an unknown tool's paths are checked as writes, and an unreadable call is denied", () => {
    expect(check(agy("delete_file", { TargetFile: "/home/u/.zshrc" }), ctx)).toContain("outside workspace ws1");
    expect(check(agy("delete_file", { TargetFile: "/w/ws1/.agents/hooks.json" }), ctx)).toContain(".agents config is managed by overbridge");
    expect(check(agy("write_to_file", { Target: "/w/ws2/x" }), ctx)).toContain("names no path");
  });

  test.each(["../ws2/x", "~/.zshrc", "/w/ws2/x", "a/../../ws2/x", "file:///w/ws2/x"])("an unknown tool naming %s under any key is checked as a write", (note) => {
    expect(check(agy("some_tool", { note }), ctx)).toContain("outside workspace ws1");
  });

  test("an unknown tool's in-workspace relative path and a value that is not a path pass", () => {
    expect(check(agy("some_tool", { note: "./x/../y" }), ctx)).toBeUndefined();
    expect(check(agy("some_tool", { note: "..foo" }), ctx)).toBeUndefined();
  });

  test("shell edits to .agents are blocked in an agy workspace only", () => {
    const agyCtx = { ...ctx, agent: AgentKind.Agy };
    expect(check(agy("run_command", { CommandLine: "echo '{}' > .agents/hooks.json" }), agyCtx)).toContain(".agents config is managed by overbridge");
    expect(check(agy("run_command", { CommandLine: "cd .agents && rm skills.json" }), agyCtx)).toContain(".agents config is managed by overbridge");
    expect(check(agy("run_command", { CommandLine: "rm -rf .agents" }), agyCtx)).toContain(".agents config is managed by overbridge");
    expect(check(agy("run_command", { CommandLine: "ls && mv ./.agents old-agents" }), agyCtx)).toContain(".agents config is managed by overbridge");
    expect(check(agy("run_command", { CommandLine: "echo x > .agents/other" }), agyCtx)).toContain(".agents config is managed by overbridge");
    expect(check(agy("run_command", { CommandLine: "ls .agents" }), agyCtx)).toBeUndefined();
    expect(check(agy("run_command", { CommandLine: "rm hooks.json", Cwd: "/w/ws1/.agents" }), agyCtx)).toContain(".agents config is managed by overbridge");
    expect(check(bash(String.raw`rg -n '\.agents|hooks\.json' src`), ctx)).toBeUndefined();
  });

  test("allows work inside the workspace", () => {
    expect(check(agy("write_to_file", { TargetFile: "/w/ws1/app/x.ts", CodeContent: "/** doc */" }), ctx)).toBeUndefined();
    expect(check(agy("run_command", { CommandLine: "bun test", Cwd: "/w/ws1/app" }), ctx)).toBeUndefined();
    expect(check(agy("search_web", { query: "bun test" }), ctx)).toBeUndefined();
  });
});
