import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKind } from "../src/agent-kind";
import { agyArgs, agyHooks, agyPluginProblems, agySettingsPath, agySkills, agyTrust, agyUntrust } from "../src/agy";
import { agyContinue, agyToolDecision, claudeTool, fromAgy, UNREADABLE_TOOL } from "../src/agy-hook";
import { agentDir } from "../src/layout";
import { agentFlag } from "../src/main";
import { root, wsDir } from "../src/paths";
import { pluginCheckFor } from "../src/start";
import { agentOf, workspaceFault } from "../src/state";

const saved = { ...process.env };
const tmp = mkdtempSync(join(tmpdir(), "overbridge-agy-"));

Object.assign(process.env, { OVERBRIDGE_ROOT: join(tmp, "workspaces"), OVERBRIDGE_NAME: "" });

mkdirSync(join(tmp, "workspaces", ".overbridge"), { recursive: true });

afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(tmp, { recursive: true, force: true });
});

describe("agent kind", () => {
  test("--agent takes the two agents and names the choices otherwise", () => {
    expect(agentFlag("agy")).toBe(AgentKind.Agy);
    expect(agentFlag(undefined)).toBeUndefined();
    expect(() => agentFlag("codex")).toThrow('--agent: unknown agent "codex"; use one of claude, agy');
  });

  test("a workspace record without an agent runs Claude, and a bad one is a fault", () => {
    expect(agentOf({ created: "", repos: {} })).toBe(AgentKind.Claude);
    expect(workspaceFault({ created: "", repos: {}, agent: "codex" })).toBe('state record has agent as "codex"');
    expect(workspaceFault({ created: "", repos: {}, agent: AgentKind.Agy })).toBeUndefined();
  });

  test("each agent gets its own skills check", () => {
    expect(pluginCheckFor(AgentKind.Agy)).toBe(agyPluginProblems);
    expect(pluginCheckFor(AgentKind.Claude)).not.toBe(agyPluginProblems);
  });
});

describe("agyArgs", () => {
  test("keeps --continue and turns the prompt after -- into -i", () => {
    expect(agyArgs(["--continue", "--", "/start-item 12"])).toEqual(["agy", "--continue", "-i", "/start-item 12"]);
    expect(agyArgs([])).toEqual(["agy"]);
  });
});

describe("agentDir", () => {
  test("an agy workspace starts in the workspace folder, where AGENTS.md and .agents are", () => {
    expect(agentDir("w1", ["app"], tmp, AgentKind.Agy)).toBe(wsDir("w1"));
    expect(agentDir("w1", ["app"], tmp, AgentKind.Claude)).toBe(join(wsDir("w1"), "app"));
  });
});

describe("agyHooks", () => {
  test("runs the guard alone on PreToolUse, with the workspace in its environment", () => {
    const hooks = agyHooks("w1").overbridge;
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0]!.hooks).toHaveLength(1);
    const command = hooks.PreToolUse[0]!.hooks[0]!.command;
    expect(command).toStartWith("env OVERBRIDGE_NAME=w1 ");
    expect(command).toContain(`OVERBRIDGE_ROOT=${root()}`);
    expect(command).toEndWith("guard --agy");
    expect(hooks.Stop[0]!.command).toEndWith("hook --agy");
  });
});

describe("agySkills", () => {
  test("lists the package's skills folders and only the required skill from the user's folder", () => {
    const pkg = join(tmp, "pkg");
    const user = join(tmp, "user-skills");
    mkdirSync(join(pkg, "plugin", "skills"), { recursive: true });
    mkdirSync(join(user, "gh-stack"), { recursive: true });
    writeFileSync(join(user, "gh-stack", "SKILL.md"), "");

    expect(agySkills(pkg, ["gh-stack"], [user, join(tmp, "empty")])).toEqual({
      entries: [{ path: join(pkg, "plugin", "skills") }, { path: user, include_only: ["gh-stack"] }],
    });
  });

  test("agyPluginProblems names a missing agy and a missing skills folder", () => {
    const { errors } = agyPluginProblems(join(tmp, "nowhere"), () => false);
    expect(errors[0]).toContain("agy is not on PATH");
    expect(errors.some((e) => e.includes("plugin-review/skills is missing"))).toBe(true);
  });
});

describe("fromAgy", () => {
  test("translates a run_command call to Bash, folding its Cwd into the command", () => {
    expect(
      fromAgy({
        hookEventName: "PreToolUse",
        conversationId: "c1",
        cwd: "/w/ws1",
        toolCall: { id: "t1", name: "run_command", args: { CommandLine: "bun test", Cwd: "/w/ws1/app" } },
      }),
    ).toEqual({
      hook_event_name: "PreToolUse",
      session_id: "c1",
      cwd: "/w/ws1",
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: 'cd "/w/ws1/app" && bun test' },
    });
  });

  test("maps events: a failed tool, the first model call of a turn, a continued stop", () => {
    expect(fromAgy({ hookEventName: "PostToolUse", error: "exit status 1" }).hook_event_name).toBe("PostToolUseFailure");
    expect(fromAgy({ hookEventName: "PreInvocation", invocationNum: 1 }).hook_event_name).toBe("UserPromptSubmit");
    expect(fromAgy({ hookEventName: "PreInvocation", invocationNum: 4 }).hook_event_name).toBeUndefined();
    expect(fromAgy({ hookEventName: "PreInvocation" }).hook_event_name).toBeUndefined();
    expect(fromAgy({ hookEventName: "Stop", continuationActive: true })).toEqual({ hook_event_name: "Stop", stop_hook_active: true });
    expect(fromAgy("nonsense")).toEqual({});
  });

  test("answers in agy's shape, giving no decision when nothing blocks", () => {
    expect(agyToolDecision(undefined)).toEqual({});
    expect(agyToolDecision("no")).toEqual({ decision: "deny", reason: "no" });
    expect(agyContinue("go on")).toEqual({ decision: "continue", reason: "go on" });
  });
});

describe("claudeTool", () => {
  test("maps known file tools by their path keys, in any case and through arrays", () => {
    expect(claudeTool("write_to_file", { TargetFile: "/w/ws1/a.ts", CodeContent: "/* not a path */" })).toEqual({ tool_name: "Write", tool_input: { paths: ["/w/ws1/a.ts"] } });
    expect(claudeTool("multi_replace_file_content", { target_files: ["/w/ws1/a.ts", "/w/ws2/b.ts"] })).toEqual({
      tool_name: "MultiEdit",
      tool_input: { paths: ["/w/ws1/a.ts", "/w/ws2/b.ts"] },
    });
    expect(claudeTool("view_file", { AbsolutePath: "/w/ws2/b.ts" })).toEqual({ tool_name: "Read", tool_input: { paths: ["/w/ws2/b.ts"] } });
  });

  test("fails closed: a file tool with no path and a shell call with no command are unreadable", () => {
    expect(claudeTool("write_to_file", { Target: "/w/ws2/x" }).tool_name).toBe(UNREADABLE_TOOL);
    expect(claudeTool("run_command", { Command: "rm -rf /" }).tool_name).toBe(UNREADABLE_TOOL);
  });

  test("checks every path an unknown tool names as a write, found by key or by value", () => {
    expect(claudeTool("delete_file", { TargetFile: "~/.zshrc" })).toEqual({ tool_name: "Write", tool_input: { paths: ["~/.zshrc"], agy_tool: "delete_file" } });
    expect(claudeTool("some_tool", { nested: { list: ["/w/ws2/x"] }, note: "two\n/lines" })).toEqual({
      tool_name: "Write",
      tool_input: { paths: ["/w/ws2/x"], agy_tool: "some_tool" },
    });
    expect(claudeTool("search_web", { query: "/etc/passwd" })).toEqual({ tool_name: "search_web", tool_input: { query: "/etc/passwd" } });
  });
});

describe("agy trust", () => {
  beforeEach(() => rmSync(agySettingsPath(), { force: true }));

  test("adds and drops only the workspace folder, keeping other settings", () => {
    writeFileSync(agySettingsPath(), JSON.stringify({ model: "m", trustedWorkspaces: ["/elsewhere"] }));
    agyTrust(wsDir("w1"));
    agyTrust(wsDir("w1"));
    expect(JSON.parse(readFileSync(agySettingsPath(), "utf8"))).toEqual({ model: "m", trustedWorkspaces: ["/elsewhere", wsDir("w1")] });
    agyUntrust(wsDir("w1"));
    expect(JSON.parse(readFileSync(agySettingsPath(), "utf8"))).toEqual({ model: "m", trustedWorkspaces: ["/elsewhere"] });
  });

  test("refuses a folder outside the root", () => {
    expect(() => agyTrust(tmp)).toThrow("refusing to change agy trust");
  });
});
