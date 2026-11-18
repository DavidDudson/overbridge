import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKind, parseAgentKind } from "../src/agent-kind";
import { agyArgs, agyHooks, agyPluginProblems, agySettingsPath, agySkills, agyTrust, agyUntrust } from "../src/agy";
import { agyContinue, agyToolDecision, claudeTool, fromAgy } from "../src/agy-hook";
import { check } from "../src/guard";
import { agentDir } from "../src/layout";
import { zellijMux } from "../src/mux";
import { root, wsDir } from "../src/paths";
import { send } from "../src/send";
import { agentOf, withState, workspaceFault } from "../src/state";

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
  test("parses the two agents and names the choices otherwise", () => {
    expect(parseAgentKind("agy", "--agent")).toBe(AgentKind.Agy);
    expect(() => parseAgentKind("codex", "--agent")).toThrow('--agent: unknown agent "codex"; use one of claude, agy');
  });

  test("a workspace record without an agent runs Claude, and a bad one is a fault", () => {
    expect(agentOf({ created: "", repos: {} })).toBe(AgentKind.Claude);
    expect(workspaceFault({ created: "", repos: {}, agent: "codex" })).toBe('state record has agent as "codex"');
    expect(workspaceFault({ created: "", repos: {}, agent: AgentKind.Agy })).toBeUndefined();
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
        toolCall: { id: "t1", name: "run_command", args: { CommandLine: "git switch main", Cwd: "/w/ws1/app" } },
      }),
    ).toEqual({
      hook_event_name: "PreToolUse",
      session_id: "c1",
      cwd: "/w/ws1",
      tool_name: "Bash",
      tool_use_id: "t1",
      tool_input: { command: 'cd "/w/ws1/app" && git switch main' },
    });
  });

  test("maps events: a failed tool, the first model call of a turn, a continued stop", () => {
    expect(fromAgy({ hookEventName: "PostToolUse", error: "exit status 1" }).hook_event_name).toBe("PostToolUseFailure");
    expect(fromAgy({ hookEventName: "PreInvocation", invocationNum: 1 }).hook_event_name).toBe("UserPromptSubmit");
    expect(fromAgy({ hookEventName: "PreInvocation", invocationNum: 4 }).hook_event_name).toBeUndefined();
    expect(fromAgy({ hookEventName: "Stop", continuationActive: true })).toEqual({ hook_event_name: "Stop", stop_hook_active: true });
    expect(fromAgy("nonsense")).toEqual({});
  });

  test("claudeTool checks the paths of file tools, and of a tool it does not know, as reads", () => {
    expect(claudeTool("write_to_file", { TargetFile: "/w/ws1/a.ts", CodeContent: "x" })).toEqual({ tool_name: "Write", tool_input: { paths: ["/w/ws1/a.ts"] } });
    expect(claudeTool("view_file", { AbsolutePath: "/w/ws2/b.ts" })).toEqual({ tool_name: "Read", tool_input: { paths: ["/w/ws2/b.ts"] } });
    expect(claudeTool("new_tool", { SomeDirectory: "/w/ws2" })).toEqual({ tool_name: "Read", tool_input: { paths: ["/w/ws2"], agy_tool: "new_tool" } });
    expect(claudeTool("search_web", { query: "x" })).toEqual({ tool_name: "search_web", tool_input: { query: "x" } });
  });

  test("answers in agy's shape", () => {
    expect(agyToolDecision(undefined)).toEqual({ decision: "allow" });
    expect(agyToolDecision("no")).toEqual({ decision: "deny", reason: "no" });
    expect(agyContinue("go on")).toEqual({ decision: "continue", reason: "go on" });
  });
});

describe("guard on agy calls", () => {
  const ctx = { root: "/w", ws: "ws1", home: "/home/u" };
  const agy = (name: string, args: Record<string, string>) => fromAgy({ hookEventName: "PreToolUse", cwd: "/w/ws1", toolCall: { name, args } });

  test("blocks branch switches, writes outside the workspace and to .agents, and foreign reads", () => {
    expect(check(agy("run_command", { CommandLine: "git switch main" }), ctx)).toContain("overbridge checkout");
    expect(check(agy("write_to_file", { TargetFile: "/w/ws2/x.ts" }), ctx)).toContain("outside workspace ws1");
    expect(check(agy("replace_file_content", { TargetFile: "/w/ws1/.agents/hooks.json" }), ctx)).toContain(".agents config is managed by overbridge");
    expect(check(agy("view_file", { AbsolutePath: "/w/ws2/x.ts" }), ctx)).toContain("outside workspace ws1");
    expect(check(agy("run_command", { CommandLine: "ls", Cwd: "/w/ws2" }), ctx)).toContain("outside workspace ws1");
  });

  test("allows work inside the workspace", () => {
    expect(check(agy("write_to_file", { TargetFile: "/w/ws1/app/x.ts" }), ctx)).toBeUndefined();
    expect(check(agy("run_command", { CommandLine: "bun test", Cwd: "/w/ws1/app" }), ctx)).toBeUndefined();
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

describe("send", () => {
  const panes = [{ id: "7", title: "w1 · claude", tab: "w1", exited: false }];

  const fake = () => {
    const sent: [string, string][] = [];

    return { sent, mux: { ...zellijMux(() => ({ ok: false, stdout: "" })), listPanes: () => panes, sendText: (id: string, text: string) => sent.push([id, text]) > 0 } };
  };

  test("types the message into the workspace's agent pane", () => {
    withState((s) => {
      s.workspaces.w1 = { created: "", repos: {}, agent: AgentKind.Agy };
      s.workspaces.cold = { created: "", repos: {}, iceboxed: { since: "" } };
    });
    const f = fake();
    expect(send("w1", "/pickup #3", f.mux)).toBe("sent to w1 (agy)");
    expect(f.sent).toEqual([["7", "/pickup #3"]]);
    expect(() => send("cold", "hi", f.mux)).toThrow("iceboxed");
    expect(() => send("nope", "hi", f.mux)).toThrow("no workspace 'nope'");
  });

  test("zellij pastes the text and then presses Enter in that pane", () => {
    const calls: string[][] = [];
    const sleep = mock(() => {});
    const { sendPause } = require("../src/mux");
    sendPause.sleep = sleep;
    const mux = zellijMux((cmd) => (calls.push(cmd), { ok: true, stdout: "" }));
    expect(mux.sendText("7", "hello")).toBe(true);
    expect(calls.map((c) => c.slice(2))).toEqual([
      ["paste", "--pane-id", "terminal_7", "hello"],
      ["send-keys", "--pane-id", "terminal_7", "Enter"],
    ]);
    expect(sleep).toHaveBeenCalled();
  });
});
