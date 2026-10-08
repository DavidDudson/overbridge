import { describe, expect, test } from "bun:test";
import { check, type HookInput } from "../src/guard";

const ctx = { root: "/w", ws: "ws1", home: "/home/u" };
const bash = (command: string, cwd = "/w/ws1/app"): HookInput => ({ cwd, tool_name: "Bash", tool_input: { command } });
const tool = (tool_name: string, tool_input: Record<string, unknown>): HookInput => ({
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
    "ws rm ws2",
    "ws up --fresh",
    "ws spinup -p 2",
    "ws checkout app feat --ws ws2",
    "cat /w/ws2/app/secret",
    "cd ~/../../w/ws2",
    "ls $HOME/../../w/ws3",
    "cd ../..",
  ])("blocks: %s", (cmd) => {
    expect(check(bash(cmd), ctx)).toBeDefined();
  });

  test.each([
    "git status",
    "git checkout -- src/x.ts",
    "git restore src/x.ts",
    "git commit -m 'fix checkout flow'",
    "git push -u origin feat",
    "gh pr create --fill",
    "ws checkout app feat",
    "ws status --all",
    "ws pr app",
    "ws add infra",
    "ws repo add infra git@github.com:u/infra.git",
    "cat /w/ws1/app/README.md",
    "ls /nix/store",
    "cd ..",
    "bun test ./test",
  ])("allows: %s", (cmd) => {
    expect(check(bash(cmd), ctx)).toBeUndefined();
  });
});

test("ignores unrelated tools", () => {
  expect(check(tool("WebFetch", { url: "https://x" }), ctx)).toBeUndefined();
});
