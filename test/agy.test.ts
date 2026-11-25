import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKind } from "../src/agent-kind";
import { agyArgs, agyHooks, agyPluginProblems, agySettingsPath, agySkills, agyTrust, agyUntrust, copyAgySkills } from "../src/agy";
import { agyContinue, agyToolDecision, claudeTool, fromAgy, UNREADABLE_TOOL } from "../src/agy-hook";
import { agentDir } from "../src/layout";
import { agentFlag } from "../src/main";
import { root, wsDir } from "../src/paths";
import { pluginCheckFor } from "../src/start";
import type { JsonObject } from "../src/json";
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
  const skill = (dir: string, name: string, text = "") => {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), text);
  };

  test("lists every package skill and only the required skill from the user's folder, first of a name winning", () => {
    const pkg = join(tmp, "pkg");
    const user = join(tmp, "user-skills");
    skill(join(pkg, "plugin", "skills"), "read-handoff");
    skill(join(pkg, "plugin-review", "skills"), "mob-review");
    mkdirSync(join(pkg, "plugin", "skills", "not-a-skill"), { recursive: true });
    skill(user, "gh-stack");
    skill(user, "other");
    skill(user, "read-handoff");

    expect(agySkills(pkg, ["gh-stack", "read-handoff"], [join(tmp, "empty"), user])).toEqual([
      { name: "read-handoff", from: join(pkg, "plugin", "skills", "read-handoff") },
      { name: "mob-review", from: join(pkg, "plugin-review", "skills", "mob-review") },
      { name: "gh-stack", from: join(user, "gh-stack") },
    ]);
  });

  test("copyAgySkills copies real folders with their files, follows symlinks, and drops skills no longer listed", () => {
    const src = join(tmp, "copy-src");
    const dest = join(tmp, "copy-ws", ".agents", "skills");
    skill(src, "read-handoff", "handoff");
    writeFileSync(join(src, "read-handoff", "HANDOFF-FORMAT.md"), "format");
    skill(src, "real-gh-stack", "stack");
    symlinkSync(join(src, "real-gh-stack"), join(src, "gh-stack"));
    skill(dest, "stale");

    copyAgySkills(dest, [
      { name: "read-handoff", from: join(src, "read-handoff") },
      { name: "gh-stack", from: join(src, "gh-stack") },
    ]);

    expect(readFileSync(join(dest, "read-handoff", "HANDOFF-FORMAT.md"), "utf8")).toBe("format");
    expect(lstatSync(join(dest, "gh-stack")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dest, "gh-stack", "SKILL.md"), "utf8")).toBe("stack");
    expect(existsSync(join(dest, "stale"))).toBe(false);
  });

  test("agyPluginProblems names a missing agy and a missing skills folder", () => {
    const { errors } = agyPluginProblems(join(tmp, "nowhere"), () => false);
    expect(errors[0]).toContain("agy is not on PATH");
    expect(errors.some((e) => e.includes("plugin-review/skills is missing"))).toBe(true);
  });

  test("agyPluginProblems names a missing required skill", () => {
    const { errors } = agyPluginProblems(join(tmp, "nowhere"), () => true, () => ["the 'gh-stack' skill is not installed"]);
    expect(errors).toContain("the 'gh-stack' skill is not installed");
  });
});

describe("fromAgy", () => {
  test("translates a run_command call to Bash, its Cwd as the cwd", () => {
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
      cwd: "/w/ws1/app",
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: "bun test" },
    });
  });

  test("a relative Cwd is taken from the hook's cwd", () => {
    expect(fromAgy({ hookEventName: "PreToolUse", cwd: "/w/ws1", toolCall: { name: "run_command", args: { CommandLine: "ls", Cwd: "app" } } }).cwd).toBe("/w/ws1/app");
  });

  test("maps events: a failed tool, the first model call of a turn, a continued stop", () => {
    expect(fromAgy({ hookEventName: "PostToolUse", error: "exit status 1" }).hook_event_name).toBe("PostToolUseFailure");
    expect(fromAgy({ hookEventName: "PreInvocation", invocationNum: 1 }).hook_event_name).toBe("UserPromptSubmit");
    expect(fromAgy({ hookEventName: "PreInvocation", invocationNum: 4 }).hook_event_name).toBeUndefined();
    expect(fromAgy({ hookEventName: "PreInvocation" }).hook_event_name).toBeUndefined();
    expect(fromAgy({ hookEventName: "Stop", continuationActive: true })).toEqual({ hook_event_name: "Stop", stop_hook_active: true });
    expect(fromAgy("nonsense")).toEqual({});
  });

  test("answers in agy's shape: a deny with its reason, and nothing at all to allow, since agy reads {} as a deny", () => {
    expect(agyToolDecision(undefined)).toBe("");
    expect(JSON.parse(agyToolDecision("no"))).toEqual({ decision: "deny", reason: "no" });
    expect(agyContinue("go on")).toEqual({ decision: "continue", reason: "go on" });
  });
});

/** A PreToolUse payload as agy CLI 1.5.16 sends it, with the paths moved under `/w`. */
const agy1516 = (name: string, args: JsonObject) => ({
  artifactDirectoryPath: "/home/u/.gemini/antigravity-cli/brain/c1",
  conversationId: "c1",
  cwd: "/w/ws1",
  hookEventName: "PreToolUse",
  lastUserInput: "read a.txt",
  modelName: "gemini-4-carbon-medium",
  stepIdx: 2,
  toolCall: { args, id: "call_1", name },
  transcriptPath: "/home/u/.gemini/antigravity-cli/brain/c1/.system_generated/logs/transcript_full.jsonl",
  workspacePaths: ["/w/ws1"],
});

describe("agy CLI 1.5.16 tool calls", () => {
  test("read_file, write_file and edit_file map to Read, Write and Edit on their Path", () => {
    expect(fromAgy(agy1516("read_file", { Path: "/w/ws1/a.txt" }))).toMatchObject({ tool_name: "Read", tool_input: { paths: ["/w/ws1/a.txt"] } });
    expect(fromAgy(agy1516("write_file", { Content: "/x", Path: "/w/ws1/b.txt" }))).toMatchObject({ tool_name: "Write", tool_input: { paths: ["/w/ws1/b.txt"] } });
    expect(fromAgy(agy1516("edit_file", { Path: "/w/ws1/a.txt", Replacement: "/y", Target: "hello" }))).toMatchObject({
      tool_name: "Edit",
      tool_input: { paths: ["/w/ws1/a.txt"] },
    });
  });

  test("run_command with agy's extra arguments and no Cwd is Bash in the hook's cwd", () => {
    expect(fromAgy(agy1516("run_command", { CommandLine: "ls -la", WaitMsBeforeAsync: 5000, toolSummary: "List files" }))).toEqual({
      hook_event_name: "PreToolUse",
      session_id: "c1",
      cwd: "/w/ws1",
      tool_name: "Bash",
      tool_use_id: "call_1",
      tool_input: { command: "ls -la" },
    });
  });

  test("run_workflow is Bash over its script path, arguments and script, in its Cwd", () => {
    expect(claudeTool("run_workflow", { ScriptPath: "/w/ws1/flow.js", Args: ["--to", "/w/ws2"], Script: "run()", Cwd: "app" }, "/w/ws1")).toEqual({
      tool_name: "Bash",
      tool_input: { command: "/w/ws1/flow.js\n--to\n/w/ws2\nrun()" },
      cwd: "/w/ws1/app",
    });
    expect(claudeTool("run_workflow", { Description: "x" }).tool_name).toBe(UNREADABLE_TOOL);
  });

  test("a message or prompt starting with / is not a path; a subagent's Workspace is", () => {
    expect(claudeTool("send_message", { Message: "/pickup #3", Recipient: "r" })).toEqual({ tool_name: "Write", tool_input: { paths: [], agy_tool: "send_message" } });
    expect(claudeTool("invoke_subagent", { Prompt: "/read-handoff", Workspace: "/w/ws2" })).toEqual({ tool_name: "Write", tool_input: { paths: ["/w/ws2"], agy_tool: "invoke_subagent" } });
    expect(claudeTool("ask_question", { questions: [{ question: "/tmp or ~?" }] })).toEqual({ tool_name: "ask_question", tool_input: { questions: [{ question: "/tmp or ~?" }] } });
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
