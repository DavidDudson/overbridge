import { describe, expect, test } from "bun:test";
import { guardReason, type HookInput } from "../src/guard";
import { checkOrchestrator, splitCommand, START_HINT } from "../src/guard-orchestrator";

const bash = (command: string): HookInput => ({ cwd: "/w", tool_name: "Bash", tool_input: { command } });
const tool = (tool_name: string, tool_input: Record<string, unknown> = {}): HookInput => ({ cwd: "/w", tool_name, tool_input });

describe("orchestrator: file and other tools", () => {
  test.each(["Write", "Edit", "MultiEdit", "NotebookEdit"])("blocks %s and says to start a workspace", (name) => {
    const reason = checkOrchestrator(tool(name, { file_path: "/w/ws1/app/x.ts" }));
    expect(reason).toContain("overbridge start");
    expect(reason).toContain(START_HINT);
  });

  test.each(["Read", "Glob", "Grep", "LS", "WebFetch", "Agent", "Skill", "AskUserQuestion", "ListAgents", "SendMessage"])("allows %s", (name) => {
    expect(checkOrchestrator(tool(name, { file_path: "/w/ws2/app/secret" }))).toBeUndefined();
  });

  test("allows MCP reads and blocks MCP writes", () => {
    expect(checkOrchestrator(tool("mcp__atlassian__getJiraIssue"))).toBeUndefined();
    expect(checkOrchestrator(tool("mcp__atlassian__searchJiraIssuesUsingJql"))).toBeUndefined();
    expect(checkOrchestrator(tool("mcp__atlassian__createJiraIssue"))).toBeDefined();
    expect(checkOrchestrator(tool("mcp__atlassian__editJiraIssue"))).toBeDefined();
    expect(checkOrchestrator(tool("mcp__atlassian__transitionJiraIssue"))).toBeDefined();
  });

  test("fails closed on a tool it does not know", () => {
    expect(checkOrchestrator(tool("SomeNewTool"))).toBeDefined();
    expect(checkOrchestrator({ cwd: "/w" })).toBeDefined();
  });
});

describe("orchestrator: bash", () => {
  test.each([
    "git commit -m x",
    "git push origin feat",
    "git switch main",
    "git checkout -b feat",
    "git reset --hard",
    "git stash",
    "git stash pop",
    "git branch feat",
    "git branch -D feat",
    "git tag v1",
    "git tag -a v1 -m x",
    "git config user.name x",
    "git remote add x y",
    "git worktree add ../x",
    "git fetch origin main:main",
    "git -c alias.st=!rm st",
    "gh pr create --fill",
    "gh pr merge 3",
    "gh pr edit 3 --title x",
    "gh issue create -t x",
    "gh issue edit 3",
    "gh issue comment 3 -b x",
    "gh api -X POST repos/u/r/issues",
    "gh api --method=PATCH repos/u/r/issues/1",
    "gh api repos/u/r/issues -f title=x",
    "gh stack push",
    "gs submit",
    "overbridge checkout app feat",
    "overbridge pr app",
    "overbridge worklist refresh",
    "overbridge worklist",
    "overbridge item create --title x",
    "overbridge item edit 3",
    "overbridge new x",
    "rm -rf x",
    "touch x",
    "mv a b",
    "bun test",
    "echo x > f",
    "echo x >> f",
    "cat a | tee f",
    "ls; rm f",
    "ls && rm f",
    "ls || rm f",
    "ls & rm f",
    "ls\nrm f",
    "x=$(rm f)",
    "echo `rm f`",
    "diff <(ls) <(ls a)",
    "find . -delete",
    "find . -exec rm {} ;",
    "fd x -x rm",
    "sort -o out in",
    "rg --pre ./run x",
    "echo 'unterminated",
    "FOO=1 rm x",
    "/bin/rm x",
    "xargs rm",
    "sed -i s/a/b/ f",
  ])("blocks: %s", (cmd) => {
    expect(checkOrchestrator(bash(cmd))).toContain("overbridge start");
  });

  test.each([
    "git status",
    "git -C app log --oneline -5",
    "git --no-pager diff main...HEAD",
    "git show HEAD:README.md",
    "git branch",
    "git branch -a",
    "git branch --list 'feat/*'",
    "git tag -l",
    "git remote -v",
    "git stash list",
    "git worktree list",
    "git config --get user.name",
    "git fetch origin",
    "git rev-parse --abbrev-ref HEAD",
    "gh pr list --search 90 --state open",
    "gh pr view 83 --comments",
    "gh pr checks 83",
    "gh issue view 90 --json title,body",
    "gh api repos/u/r/pulls/3",
    "gh api -X GET repos/u/r/pulls",
    "gh search issues orchestrator",
    "gh stack view",
    "overbridge status --all",
    "overbridge whoami",
    "overbridge worklist show",
    "overbridge repo ls",
    "overbridge item view 90",
    "overbridge config get commands.test",
    "overbridge start app 12",
    "overbridge start app 12 --prompt 'file a ticket for X; then stop'",
    'overbridge start app --task file-x --prompt "file a ticket for X > Y"',
    "overbridge rm old-ws",
    "overbridge cleanup --json",
    "overbridge cleanup --dry-run --json; overbridge rm ENG-1; overbridge rm ENG-2",
    "overbridge release app",
    "ws status",
    "cd /w/ws1/app && git log | head -5",
    "rg -n 'a|b' src 2>&1 | head",
    "ls /w > /dev/null 2>&1",
    "jq .x < file.json",
    "FOO=1 git status",
    "cat a | wc -l",
    "find . -name '*.ts'",
    "",
  ])("allows: %s", (cmd) => {
    expect(checkOrchestrator(bash(cmd))).toBeUndefined();
  });
});

describe("splitCommand", () => {
  test("keeps separators inside quotes", () => {
    expect(splitCommand(`rg 'a;b|c' && echo "x && y"`)).toEqual({ segments: [["rg", "a;b|c"], ["echo", "x && y"]] });
  });

  test("drops descriptor redirections", () => {
    expect(splitCommand("ls 2>&1 >/dev/null")).toEqual({ segments: [["ls"]] });
  });
});

describe("guardReason", () => {
  const writeInWs = tool("Write", { file_path: "/nowhere/ws1/x.ts" });

  test("an orchestration tab gets the orchestrator guard wherever its cwd is", () => {
    expect(guardReason({ ...writeInWs, cwd: "/anywhere" }, { OVERBRIDGE_TAB: "@root", OVERBRIDGE_NAME: "" })).toContain(
      "overbridge start",
    );
  });

  test("a workspace Claude never gets the orchestrator guard, even with OVERBRIDGE_TAB inherited", () => {
    const reason = guardReason(bash("git commit -m x"), { OVERBRIDGE_TAB: "@root", OVERBRIDGE_NAME: "ws1" });
    expect(reason ?? "").not.toContain("orchestrator");
  });

  test("outside any workspace and tab there is no guard", () => {
    const saved = process.env.OVERBRIDGE_NAME;
    process.env.OVERBRIDGE_NAME = "";
    try {
      expect(guardReason({ ...writeInWs, cwd: "/tmp/not-a-workspace" }, {})).toBeUndefined();
    } finally {
      process.env.OVERBRIDGE_NAME = saved;
    }
  });
});
