import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFromFlags } from "../src/agent-launch";
import { RELAUNCH_SIGNAL, relaunchRequestPath, SessionMode, takeRelaunchRequest } from "../src/agent-supervisor";
import { AgentKind } from "../src/agent-kind";
import type { AgentState } from "../src/agent-state";
import { zellijMux } from "../src/mux";
import { type Caller, currentCaller, relaunch, type RelaunchDeps, type RelaunchOptions, switchModel } from "../src/relaunch";
import { readState, withState, type WorkspaceState } from "../src/state";
import type { RunResult } from "../src/util";

let tmp: string;
const saved = process.env.OVERBRIDGE_ROOT;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-relaunch-")));
  process.env.OVERBRIDGE_ROOT = tmp;
  mkdirSync(join(tmp, ".overbridge"), { recursive: true });
});

afterEach(() => {
  saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
  rmSync(tmp, { recursive: true, force: true });
});

const addWorkspace = (ws: string, extra: Partial<WorkspaceState> = {}) =>
  withState((s) => {
    s.workspaces[ws] = { created: "2026-01-01T00:00:00.000Z", repos: {}, ...extra };
  });

const ok = (stdout = ""): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });

interface Fake {
  deps: RelaunchDeps;
  signals: [number, string][];
  opened: [string, string, SessionMode][];
  zellij: string[][];
}

function fake(o: { launcher?: boolean; caller?: Caller; state?: AgentState; tabs?: string; signalFails?: boolean } = {}): Fake {
  const signals: Fake["signals"] = [];
  const opened: Fake["opened"] = [];
  const zellij: Fake["zellij"] = [];

  const deps: RelaunchDeps = {
    mux: zellijMux(
      (cmd) => {
        zellij.push(cmd);

        return cmd[2] === "list-tabs" || cmd[2] === "query-tab-names" ? ok(o.tabs ?? "") : ok();
      },
      { env: { ZELLIJ: "0" } },
    ),
    launcher: () => (o.launcher ? { pid: 100, child: 101 } : undefined),
    caller: () => o.caller ?? { agent: false, interactive: true },
    signal: (pid, sig) => {
      if (o.signalFails) {
        throw new Error("ESRCH");
      }

      signals.push([pid, sig]);
    },
    agentState: () => o.state,
    open: (ws, prompt, session) => void opened.push([ws, prompt, session]),
  };

  return { deps, signals, opened, zellij };
}

const opts = (o: Partial<RelaunchOptions> = {}): RelaunchOptions => ({ launch: launchFromFlags({ noCodeMode: true, chrome: true }), session: SessionMode.Continue, ...o });

describe("relaunch", () => {
  test("with a supervisor: writes a handoff, stores the launch, and signals the supervisor", () => {
    addWorkspace("ws1");
    const f = fake({ launcher: true, state: "idle" });
    const handoff = relaunch("ws1", opts({ prompt: "carry on" }), f.deps);

    expect(existsSync(handoff)).toBe(true);
    expect(handoff).toEndWith("-relaunch.md");
    expect(readState().workspaces.ws1?.launch).toEqual({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: "0" }, args: ["--chrome"] });
    expect(f.signals).toEqual([[100, RELAUNCH_SIGNAL]]);
    expect(takeRelaunchRequest("ws1")).toMatchObject({ session: SessionMode.Continue, prompt: "/read-handoff --then carry on" });
    expect(f.opened).toEqual([]);
  });

  test("no flags clear the workspace's launch settings", () => {
    addWorkspace("ws1", { launch: { env: { A: "1" }, args: [] } });
    relaunch("ws1", opts({ launch: { env: {}, args: [] } }), fake({ launcher: true }).deps);
    expect(readState().workspaces.ws1?.launch).toBeUndefined();
  });

  test("without a supervisor: closes the tab and opens it again", () => {
    addWorkspace("ws1");
    const f = fake({ tabs: "ws1\nother" });
    relaunch("ws1", opts({ session: SessionMode.Fresh }), f.deps);

    expect(f.opened).toEqual([["ws1", "/read-handoff", SessionMode.Fresh]]);
    expect(f.signals).toEqual([]);
    expect(existsSync(relaunchRequestPath("ws1"))).toBe(false);
  });

  test("refuses a busy agent unless forced", () => {
    addWorkspace("ws1");
    expect(() => relaunch("ws1", opts(), fake({ launcher: true, state: "busy" }).deps)).toThrow("--force");
    expect(readState().workspaces.ws1?.launch).toBeUndefined();
    const f = fake({ launcher: true, state: "busy" });
    relaunch("ws1", opts({ force: true }), f.deps);
    expect(f.signals).toHaveLength(1);
  });

  test("an agent may relaunch its own workspace mid-turn, but no other", () => {
    addWorkspace("ws1");
    addWorkspace("ws2");
    const self = fake({ launcher: true, caller: { ws: "ws1", agent: true, interactive: false }, state: "busy" });
    relaunch("ws1", opts(), self.deps);
    expect(self.signals).toHaveLength(1);

    const other = fake({ launcher: true, caller: { ws: "ws2", agent: true, interactive: false }, state: "idle" });
    expect(() => relaunch("ws1", opts(), other.deps)).toThrow("only its own workspace (ws2)");
    expect(other.signals).toEqual([]);
  });

  test("a self-relaunch with no supervisor refuses rather than closing its own tab", () => {
    addWorkspace("ws1");
    const f = fake({ caller: { ws: "ws1", agent: false, interactive: true }, tabs: "ws1" });
    expect(() => relaunch("ws1", opts(), f.deps)).toThrow("from another tab");
    expect(f.zellij.some((c) => c.includes("close-tab-by-id") || c.includes("close-tab"))).toBe(false);
  });

  test("an agent may set only the shorthands; the user may set env and agent arguments", () => {
    addWorkspace("ws1");
    const wide = launchFromFlags({ env: ["A=1"], args: ["--permission-mode", "bypassPermissions"] });
    const asAgent = fake({ launcher: true, caller: { ws: "ws1", agent: true, interactive: false } });
    expect(() => relaunch("ws1", opts({ launch: wide }), asAgent.deps)).toThrow("for the user");
    expect(() => relaunch("ws1", opts({ launch: wide }), fake({ launcher: true, caller: { agent: true, interactive: false } }).deps)).toThrow("for the user");
    expect(readState().workspaces.ws1?.launch).toBeUndefined();

    const piped = fake({ launcher: true, caller: { agent: false, interactive: false } });
    expect(() => relaunch("ws1", opts({ launch: wide }), piped.deps)).toThrow("in a terminal");

    const asUser = fake({ launcher: true, caller: { ws: "other", agent: false, interactive: true } });
    relaunch("ws1", opts({ launch: wide }), asUser.deps);
    expect(readState().workspaces.ws1?.launch).toEqual(wide);
  });

  test("a supervisor that is gone falls back to reopening the tab, leaving no request behind", () => {
    addWorkspace("ws1");
    const f = fake({ launcher: true, signalFails: true, tabs: "ws1" });
    relaunch("ws1", opts(), f.deps);
    expect(f.opened).toEqual([["ws1", "/read-handoff", SessionMode.Continue]]);
    expect(existsSync(relaunchRequestPath("ws1"))).toBe(false);
  });

  test("refuses iceboxed, removing, agy with Claude-only flags, and orchestration tabs", () => {
    addWorkspace("cold", { iceboxed: { since: "2026-01-01T00:00:00.000Z" } });
    addWorkspace("going", { removing: { since: new Date().toISOString(), pid: process.pid } });
    expect(() => relaunch("going", opts(), fake({ launcher: true }).deps)).toThrow("being removed");
    addWorkspace("agy1", { agent: AgentKind.Agy });
    const f = fake({ launcher: true });
    expect(() => relaunch("cold", opts(), f.deps)).toThrow("overbridge thaw cold");
    expect(() => relaunch("agy1", opts(), f.deps)).toThrow("Claude Code settings");
    relaunch("agy1", opts({ launch: launchFromFlags({ env: ["X=1"] }) }), f.deps);
    expect(() => relaunch("@root", opts(), f.deps)).toThrow("orchestration tab");
  });

  test("with its supervisor gone, a relaunch from the workspace's own tab refuses rather than close that tab", () => {
    addWorkspace("ws1");
    const f = fake({ launcher: true, signalFails: true, caller: { ws: "ws1", agent: true, interactive: false }, tabs: "ws1" });
    expect(() => relaunch("ws1", opts(), f.deps)).toThrow("supervisor is gone");
    expect(f.zellij.some((c) => c.some((w) => w.startsWith("close-tab")))).toBe(false);
    expect(f.opened).toEqual([]);
    expect(existsSync(relaunchRequestPath("ws1"))).toBe(false);
  });

  test.each([
    ["the agent in its own tab", { ws: "ws1", agent: true, interactive: false }, false, true],
    ["the user in the workspace's terminal", { ws: "ws1", agent: false, interactive: true }, false, false],
    ["the orchestrator", { agent: true, interactive: false }, false, false],
    ["the user with --force", { ws: "ws1", agent: false, interactive: true }, true, true],
  ])("a busy agent: %s", (_, caller: Caller, force, signals) => {
    addWorkspace("ws1");
    const f = fake({ launcher: true, caller, state: "busy" });
    const run = () => relaunch("ws1", opts({ force }), f.deps);

    if (signals) {
      run();
      expect(f.signals).toHaveLength(1);
    } else {
      expect(run).toThrow("--force");
    }
  });
});

describe("currentCaller", () => {
  test("with no supervisor above, CLAUDECODE marks an agent and OVERBRIDGE_NAME names its workspace", () => {
    addWorkspace("ws1");
    expect(currentCaller({ CLAUDECODE: "1", OVERBRIDGE_NAME: "ws1" })).toMatchObject({ ws: "ws1", agent: true });
    expect(currentCaller({ OVERBRIDGE_NAME: "" })).toMatchObject({ ws: undefined, agent: false });
  });
});

describe("switchModel", () => {
  const cont = { session: SessionMode.Continue };

  test("sets the model, keeps the other launch settings, and restarts the agent", () => {
    addWorkspace("ws1", { launch: { env: { A: "1" }, args: ["--chrome", "--model", "haiku"] } });
    const f = fake({ launcher: true, state: "idle" });
    switchModel("ws1", "opus", cont, f.deps);

    expect(readState().workspaces.ws1?.launch).toEqual({ env: { A: "1" }, args: ["--chrome", "--model", "opus"] });
    expect(f.signals).toEqual([[100, RELAUNCH_SIGNAL]]);
  });

  test("default drops the model, and with nothing else left the launch settings", () => {
    addWorkspace("ws1", { launch: { env: {}, args: ["--model", "opus"] } });
    switchModel("ws1", "default", cont, fake({ launcher: true }).deps);
    expect(readState().workspaces.ws1?.launch).toBeUndefined();
  });

  test("an agent may switch the model even when the user set env and agent arguments", () => {
    addWorkspace("ws1", { launch: { env: { A: "1" }, args: ["--permission-mode", "plan"] } });
    const orchestrator = fake({ launcher: true, caller: { agent: true, interactive: false }, state: "idle" });
    switchModel("ws1", "sonnet", cont, orchestrator.deps);
    expect(readState().workspaces.ws1?.launch).toEqual({ env: { A: "1" }, args: ["--permission-mode", "plan", "--model", "sonnet"] });
  });

  test("refuses a model that reads as a flag, before anything is written", () => {
    addWorkspace("ws1");
    const f = fake({ launcher: true, caller: { agent: true, interactive: false } });
    expect(() => switchModel("ws1", "--dangerously-skip-permissions", cont, f.deps)).toThrow("model '--dangerously-skip-permissions'");
    expect(readState().workspaces.ws1?.launch).toBeUndefined();
    expect(f.signals).toEqual([]);
  });

  test("relaunch itself still refuses a model passed by an agent as an agent argument", () => {
    addWorkspace("ws1");
    const agent = fake({ launcher: true, caller: { ws: "ws1", agent: true, interactive: false } });
    expect(() => relaunch("ws1", opts({ launch: launchFromFlags({ args: ["--model", "opus"] }) }), agent.deps)).toThrow("for the user");
  });

  test("the handoff names the model switch", () => {
    addWorkspace("ws1");
    const handoff = switchModel("ws1", "opus", cont, fake({ launcher: true }).deps);
    expect(readFileSync(handoff, "utf8")).toContain("`overbridge model ws1 opus` restarted the agent on opus");
  });

  test("an agent still may not switch another workspace's model", () => {
    addWorkspace("ws1");
    const other = fake({ launcher: true, caller: { ws: "ws2", agent: true, interactive: false } });
    expect(() => switchModel("ws1", "opus", cont, other.deps)).toThrow("only its own workspace");
  });
});
