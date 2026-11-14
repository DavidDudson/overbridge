import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimRefresh, EVENT_STATE, recordState, REFRESH_AFTER_MS } from "../src/agent-hook";
import { AGENT_STATES, agentStatePath, EndReason, endedForGood, readAgentState, sessionEndedForGood, STALE_MS } from "../src/agent-state";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let tmp: string;
let meta: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;

const stateOf = (ws: string) => JSON.parse(readFileSync(agentStatePath(meta, ws), "utf8"));

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-hook-"));
  meta = join(tmp, ".overbridge");
  process.env.OVERBRIDGE_ROOT = tmp;
});

afterEach(() => {
  savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
  rmSync(tmp, { recursive: true, force: true });
});

describe("event mapping", () => {
  test("every mapped state is a known state", () => {
    for (const state of Object.values(EVENT_STATE)) expect(AGENT_STATES).toContain(state);
  });

  test("turn start and tool use are busy; stop is done; a prompt waits; session bounds", () => {
    expect(EVENT_STATE).toMatchObject({
      SessionStart: "idle",
      UserPromptSubmit: "busy",
      PostToolUse: "busy",
      Notification: "waiting",
      Stop: "done",
      SessionEnd: "end",
    });
  });
});

describe("recordState", () => {
  test("writes state and time", () => {
    recordState(meta, "w1", "busy", 1000);
    expect(stateOf("w1")).toEqual({ state: "busy", at: 1000 });
  });

  test("an unchanged state is not rewritten right away, but a change or a later call is", () => {
    recordState(meta, "w1", "busy", 1000);
    recordState(meta, "w1", "busy", 1500);
    expect(stateOf("w1").at).toBe(1000);
    recordState(meta, "w1", "done", 1600);
    expect(stateOf("w1")).toEqual({ state: "done", at: 1600 });
    recordState(meta, "w1", "done", 9000);
    expect(stateOf("w1").at).toBe(9000);
  });

  test("replaces an unreadable file", () => {
    mkdirSync(join(meta, "agent"), { recursive: true });
    writeFileSync(agentStatePath(meta, "w1"), "garbage");
    recordState(meta, "w1", "idle", 5);
    expect(stateOf("w1").state).toBe("idle");
  });
});

describe("stale expiry", () => {
  const put = (state: string, at: number) => {
    mkdirSync(join(meta, "agent"), { recursive: true });
    writeFileSync(agentStatePath(meta, "w1"), JSON.stringify({ state, at }));
  };

  test("busy expires after minutes, the rest after a day", () => {
    const now = 10_000_000_000;
    put("busy", now - STALE_MS.busy + 1);
    expect(readAgentState("w1", now)).toBe("busy");
    put("busy", now - STALE_MS.busy - 1);
    expect(readAgentState("w1", now)).toBeUndefined();
    put("done", now - 3600_000);
    expect(readAgentState("w1", now)).toBe("done");
    put("done", now - STALE_MS.done - 1);
    expect(readAgentState("w1", now)).toBeUndefined();
  });

  test("an ended session never goes stale", () => {
    const now = 10_000_000_000;
    put("end", now - 30 * 24 * 3600_000);
    expect(readAgentState("w1", now)).toBe("end");
  });
});

describe("session end reasons", () => {
  const putEnd = (reason?: string) => {
    mkdirSync(join(meta, "agent"), { recursive: true });
    writeFileSync(agentStatePath(meta, "w1"), JSON.stringify({ state: "end", at: Date.now(), ...(reason ? { reason } : {}) }));
  };

  test("only a deliberate exit counts as ended for good", () => {
    expect(endedForGood(EndReason.PromptInputExit)).toBe(true);
    [EndReason.Other, EndReason.Logout, EndReason.Clear, EndReason.Resume, undefined].forEach((reason) => expect(endedForGood(reason)).toBe(false));
  });

  test("reads the recorded reason", () => {
    putEnd(EndReason.PromptInputExit);
    expect(sessionEndedForGood("w1")).toBe(true);
    putEnd(EndReason.Other);
    expect(sessionEndedForGood("w1")).toBe(false);
    putEnd();
    expect(sessionEndedForGood("w1")).toBe(false);
  });

  test("recordState writes the reason with end", () => {
    recordState(meta, "w1", "end", 1000, [], EndReason.PromptInputExit);
    expect(stateOf("w1")).toEqual({ state: "end", at: 1000, reason: EndReason.PromptInputExit });
  });
});

describe("claimRefresh", () => {
  const touch = (path: string, ageMs: number, now: number) => {
    mkdirSync(join(meta, "top"), { recursive: true });
    writeFileSync(path, "{}");
    utimesSync(path, (now - ageMs) / 1000, (now - ageMs) / 1000);
  };

  test("claims when there is no cache, once", () => {
    const now = Date.now();
    expect(claimRefresh(meta, "w1", now)).toBe(true);
    expect(claimRefresh(meta, "w1", now + 1000)).toBe(false);
  });

  test("a fresh cache needs no refresh, a stale one does", () => {
    const now = Date.now();
    touch(join(meta, "top", "w1.json"), REFRESH_AFTER_MS - 5_000, now);
    expect(claimRefresh(meta, "w1", now)).toBe(false);
    touch(join(meta, "top", "w1.json"), REFRESH_AFTER_MS + 5_000, now);
    expect(claimRefresh(meta, "w1", now)).toBe(true);
  });

  test("a stale lock is claimed again", () => {
    const now = Date.now();
    touch(join(meta, "top", "w1.refresh"), 60_000, now);
    expect(claimRefresh(meta, "w1", now)).toBe(true);
  });
});

describe("overbridge hook", () => {
  const hook = (input: string, name: string | undefined, extra: Record<string, string> = {}) => {
    const p = Bun.spawnSync({
      cmd: [process.execPath, CLI, "hook"],
      env: { ...process.env, OVERBRIDGE_ROOT: tmp, OVERBRIDGE_NAME: name ?? "", OVERBRIDGE_SELF: "true", ...extra },
      stdin: Buffer.from(input),
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };

  test("records the state for the bound workspace and stays silent", () => {
    const r = hook(JSON.stringify({ hook_event_name: "UserPromptSubmit" }), "w1");
    expect(r).toEqual({ code: 0, out: "", err: "" });
    expect(stateOf("w1").state).toBe("busy");
  });

  test("ignores unlisted events and unbound sessions", () => {
    expect(hook(JSON.stringify({ hook_event_name: "PreCompact" }), "w2").code).toBe(0);
    expect(existsSync(agentStatePath(meta, "w2"))).toBe(false);
    expect(hook(JSON.stringify({ hook_event_name: "Stop" }), undefined).code).toBe(0);
    expect(existsSync(join(meta, "agent"))).toBe(false);
  });

  test("records an orchestration tab's state under its tab name, without a top panel refresh", () => {
    const r = hook(JSON.stringify({ hook_event_name: "Stop" }), undefined, { OVERBRIDGE_TAB: "@root" });
    expect(r).toEqual({ code: 0, out: "", err: "" });
    expect(stateOf("@root").state).toBe("done");
    expect(existsSync(join(meta, "top"))).toBe(false);
  });

  test("a deliberate exit records end with its reason", () => {
    hook(JSON.stringify({ hook_event_name: "SessionEnd", reason: EndReason.PromptInputExit }), "w1");
    expect(stateOf("w1")).toMatchObject({ state: "end", reason: EndReason.PromptInputExit });
  });

  test("/clear and /resume do not end the workspace's session", () => {
    hook(JSON.stringify({ hook_event_name: "UserPromptSubmit" }), "w1");
    [EndReason.Clear, EndReason.Resume].forEach((reason) => {
      hook(JSON.stringify({ hook_event_name: "SessionEnd", reason }), "w1");
      expect(stateOf("w1").state).toBe("busy");
    });
  });

  test("the idle notification leaves done alone; a permission prompt waits", () => {
    hook(JSON.stringify({ hook_event_name: "Stop" }), "w1");
    hook(JSON.stringify({ hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" }), "w1");
    expect(stateOf("w1").state).toBe("done");
    hook(JSON.stringify({ hook_event_name: "Notification", notification_type: "permission_prompt" }), "w1");
    expect(stateOf("w1").state).toBe("waiting");
  });

  test("subagent start and stop turn done into bg and back; a session boundary clears them", () => {
    hook(JSON.stringify({ hook_event_name: "Stop" }), "w1");
    hook(JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "a1" }), "w1");
    expect(readAgentState("w1")).toBe("bg");
    hook(JSON.stringify({ hook_event_name: "SubagentStop", agent_id: "a1" }), "w1");
    expect(readAgentState("w1")).toBe("done");
    hook(JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "a2" }), "w1");
    hook(JSON.stringify({ hook_event_name: "SessionEnd", reason: EndReason.Other }), "w1");
    expect(existsSync(join(meta, "agent", "w1.sub"))).toBe(false);
  });

  test("a compaction keeps running subagents; a fresh start clears them", () => {
    hook(JSON.stringify({ hook_event_name: "SubagentStart", agent_id: "a1" }), "w1");
    hook(JSON.stringify({ hook_event_name: "SessionStart", source: "compact" }), "w1");
    expect(existsSync(join(meta, "agent", "w1.sub", "a1"))).toBe(true);
    hook(JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }), "w1");
    expect(existsSync(join(meta, "agent", "w1.sub"))).toBe(false);
  });

  test("bad input never fails the agent", () => {
    const r = hook("not json", "w1");
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });
});
