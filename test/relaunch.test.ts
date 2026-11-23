import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchFromFlags, RELAUNCH_SIGNAL, relaunchRequestPath, SessionMode, takeRelaunchRequest } from "../src/agent-launch";
import { AgentKind } from "../src/agent-kind";
import type { AgentState } from "../src/agent-state";
import { zellijMux } from "../src/mux";
import { relaunch, type RelaunchDeps, type RelaunchOptions } from "../src/relaunch";
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

function fake(o: { launcher?: boolean; caller?: string; state?: AgentState; tabs?: string } = {}): Fake {
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
    callerWorkspace: () => o.caller,
    signal: (pid, sig) => void signals.push([pid, sig]),
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
    const self = fake({ launcher: true, caller: "ws1", state: "busy" });
    relaunch("ws1", opts(), self.deps);
    expect(self.signals).toHaveLength(1);

    const other = fake({ launcher: true, caller: "ws2", state: "idle" });
    expect(() => relaunch("ws1", opts(), other.deps)).toThrow("only its own workspace (ws2)");
    expect(other.signals).toEqual([]);
  });

  test("a self-relaunch with no supervisor refuses rather than closing its own tab", () => {
    addWorkspace("ws1");
    const f = fake({ caller: "ws1", tabs: "ws1" });
    expect(() => relaunch("ws1", opts(), f.deps)).toThrow("older overbridge");
    expect(f.zellij.some((c) => c.includes("close-tab-by-id") || c.includes("close-tab"))).toBe(false);
  });

  test("refuses iceboxed, agy with Claude-only flags, and orchestration tabs", () => {
    addWorkspace("cold", { iceboxed: { since: "2026-01-01T00:00:00.000Z" } });
    addWorkspace("agy1", { agent: AgentKind.Agy });
    const f = fake({ launcher: true });
    expect(() => relaunch("cold", opts(), f.deps)).toThrow("overbridge thaw cold");
    expect(() => relaunch("agy1", opts(), f.deps)).toThrow("Claude Code settings");
    relaunch("agy1", opts({ launch: launchFromFlags({ env: ["X=1"] }) }), f.deps);
    expect(() => relaunch("@root", opts(), f.deps)).toThrow("orchestration tab");
  });
});
