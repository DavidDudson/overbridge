import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME_ARG, CODE_MODE_ENV, envNameFault, launchFault, launchFromFlags, mergeLaunch, onlyShorthands, parseEnvPairs, usesClaudeOnly } from "../src/agent-launch";
import {
  ancestry,
  clearLauncher,
  descendants,
  parseRelaunchRequest,
  readLauncher,
  REQUEST_MAX_AGE_MS,
  relaunchExtra,
  SessionMode,
  takeRelaunchRequest,
  workspaceAbove,
  writeLauncher,
  writeRelaunchRequest,
} from "../src/agent-supervisor";
import { AgentKind } from "../src/agent-kind";
import { agentLaunchOf } from "../src/commands";
import type { WorkspaceState } from "../src/state";
import { type RootLayers, rootLayersFrom } from "../src/project-config";

describe("launch settings", () => {
  test("mergeLaunch: later env wins, args append in order", () => {
    const base = { env: { A: "1", B: "1" }, args: ["--x"] };
    const over = { env: { B: "2" }, args: ["--y"] };
    expect(mergeLaunch(base, undefined, over)).toEqual({ env: { A: "1", B: "2" }, args: ["--x", "--y"] });
    expect(mergeLaunch()).toEqual({ env: {}, args: [] });
  });

  test("launchFromFlags turns the shorthands into env and args", () => {
    expect(launchFromFlags({ noCodeMode: true, chrome: true, env: ["K=a=b"], args: ["--model", "x"] })).toEqual({
      env: { [CODE_MODE_ENV]: "0", K: "a=b" },
      args: [CHROME_ARG, "--model", "x"],
    });
    expect(launchFromFlags({})).toEqual({ env: {}, args: [] });
  });

  test("parseEnvPairs rejects a pair with no = or a bad name", () => {
    expect(parseEnvPairs(["A=", "B_2=x"])).toEqual({ A: "", B_2: "x" });
    expect(() => parseEnvPairs(["A"])).toThrow("'A': expected NAME=VALUE");
    expect(() => parseEnvPairs(["1A=x"])).toThrow("'1A=x': expected a name");
    expect(() => parseEnvPairs(["OVERBRIDGE_NAME=other"])).toThrow("OVERBRIDGE_* variables are set by overbridge");
    expect(envNameFault("OVERBRIDGE_ROOT")).toBeDefined();
  });

  test("usesClaudeOnly spots the Claude Code shorthands", () => {
    expect(usesClaudeOnly(launchFromFlags({ chrome: true }))).toBe(true);
    expect(usesClaudeOnly(launchFromFlags({ noCodeMode: true }))).toBe(true);
    expect(usesClaudeOnly(launchFromFlags({ env: ["X=1"] }))).toBe(false);
  });

  test("onlyShorthands allows what --no-code-mode and --chrome set, and nothing else", () => {
    expect(onlyShorthands(launchFromFlags({ noCodeMode: true, chrome: true }))).toBe(true);
    expect(onlyShorthands(launchFromFlags({}))).toBe(true);
    expect(onlyShorthands(launchFromFlags({ env: ["A=1"] }))).toBe(false);
    expect(onlyShorthands(launchFromFlags({ env: [`${CODE_MODE_ENV}=1`] }))).toBe(false);
    expect(onlyShorthands(launchFromFlags({ args: ["--dangerously-skip-permissions"] }))).toBe(false);
  });

  test("launchFault checks the shape stored in state", () => {
    expect(launchFault({ env: { A: "1" }, args: ["x"] })).toBeUndefined();
    expect(launchFault({ env: { A: 1 }, args: [] })).toContain("env");
    expect(launchFault({ env: {}, args: "x" })).toContain("args");
    expect(launchFault("x")).toBeDefined();
    expect(launchFault({ env: { OVERBRIDGE_NAME: "x" }, args: [] })).toContain("env");
  });
});

describe("agentLaunchOf", () => {
  const layers = (agentLaunch: RootLayers["agentLaunch"]): RootLayers => ({ ...rootLayersFrom(undefined, "config.yml"), agentLaunch });

  const ws = (agent: AgentKind | undefined = undefined, launch: { env: Record<string, string>; args: string[] } | undefined = undefined): WorkspaceState => {
    const w: WorkspaceState = { created: "2026-01-01T00:00:00.000Z", repos: {} };

    if (agent) w.agent = agent;

    if (launch) w.launch = launch;

    return w;
  };

  test.each([
    ["the workspace's env wins and args follow the root's", ws(undefined, { env: { A: "2" }, args: ["--w"] }), { env: { A: "2", B: "1" }, args: ["--r", "--w"] }],
    ["with no workspace launch the root's applies", ws(), { env: { A: "1", B: "1" }, args: ["--r"] }],
    ["an agy workspace gets the agy layer, never Claude's", ws(AgentKind.Agy), { env: {}, args: ["--agy"] }],
  ])("%s", (_, w, expected) => {
    const root = layers({ claude: { env: { A: "1", B: "1" }, args: ["--r"] }, agy: { env: {}, args: ["--agy"] } });
    expect(agentLaunchOf(w, root)).toEqual(expected);
  });
});

describe("relaunch request", () => {
  const now = 1_000_000;

  test("a fresh request parses; an old or malformed one does not", () => {
    expect(parseRelaunchRequest({ session: "continue", prompt: "/read-handoff", requestedAtMs: now }, now)).toEqual({ session: SessionMode.Continue, prompt: "/read-handoff", requestedAtMs: now });
    expect(parseRelaunchRequest({ session: "continue", prompt: "p", requestedAtMs: now - REQUEST_MAX_AGE_MS - 1 }, now)).toBeUndefined();
    expect(parseRelaunchRequest({ session: "later", prompt: "p", requestedAtMs: now }, now)).toBeUndefined();
    expect(parseRelaunchRequest(null, now)).toBeUndefined();
  });

  test("relaunchExtra resumes only for a continue session", () => {
    expect(relaunchExtra({ session: SessionMode.Continue, prompt: "/read-handoff", requestedAtMs: now })).toEqual(["--continue", "--", "/read-handoff"]);
    expect(relaunchExtra({ session: SessionMode.Fresh, prompt: "/read-handoff", requestedAtMs: now })).toEqual(["--", "/read-handoff"]);
  });
});

describe("process ancestry", () => {
  const parents = new Map([
    [50, 40],
    [40, 30],
    [30, 1],
    [7, 8],
    [8, 7],
  ]);

  const parentOf = (pid: number) => parents.get(pid);

  test("walks to pid 1 and stops on a loop", () => {
    expect(ancestry(50, parentOf)).toEqual([50, 40, 30]);
    expect(ancestry(7, parentOf)).toEqual([7, 8]);
    expect(ancestry(99, parentOf)).toEqual([99]);
  });

  test("descendants walks the whole tree under a pid", () => {
    const procs = [
      { pid: 2, ppid: 1, comm: "sh", state: "S" },
      { pid: 3, ppid: 2, comm: "claude", state: "S" },
      { pid: 4, ppid: 3, comm: "node", state: "S" },
      { pid: 5, ppid: 1, comm: "other", state: "S" },
    ];

    expect(descendants(2, procs)).toEqual([3, 4]);
    expect(descendants(5, procs)).toEqual([]);
  });

  test("workspaceAbove names the workspace whose supervisor is an ancestor", () => {
    const launchers = { a: { pid: 30, child: 31 }, b: { pid: 60, child: 61 } };
    expect(workspaceAbove([50, 40, 30], launchers)).toBe("a");
    expect(workspaceAbove([70], launchers)).toBeUndefined();
  });
});

describe("launcher and request files", () => {
  let tmp: string;
  const saved = process.env.OVERBRIDGE_ROOT;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-launch-")));
    process.env.OVERBRIDGE_ROOT = tmp;
  });

  afterEach(() => {
    saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("clearLauncher leaves another supervisor's file alone", () => {
    writeLauncher("ws", { pid: 10, child: 11 });
    clearLauncher("ws", 99);
    expect(readLauncher("ws")).toEqual({ pid: 10, child: 11 });
    clearLauncher("ws", 10);
    expect(readLauncher("ws")).toBeUndefined();
  });

  test("a request is taken once", () => {
    writeRelaunchRequest("ws", { session: SessionMode.Fresh, prompt: "p", requestedAtMs: Date.now() });
    expect(takeRelaunchRequest("ws")?.prompt).toBe("p");
    expect(takeRelaunchRequest("ws")).toBeUndefined();
  });
});
