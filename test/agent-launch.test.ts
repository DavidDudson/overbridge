import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ancestry,
  CHROME_ARG,
  CODE_MODE_ENV,
  clearLauncher,
  launchFault,
  launchFromFlags,
  mergeLaunch,
  parseEnvPairs,
  parseRelaunchRequest,
  readLauncher,
  REQUEST_MAX_AGE_MS,
  relaunchExtra,
  SessionMode,
  takeRelaunchRequest,
  usesClaudeOnly,
  workspaceAbove,
  writeLauncher,
  writeRelaunchRequest,
} from "../src/agent-launch";

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
    expect(() => parseEnvPairs(["A"])).toThrow("got 'A'");
    expect(() => parseEnvPairs(["1A=x"])).toThrow("got '1A=x'");
  });

  test("usesClaudeOnly spots the Claude Code shorthands", () => {
    expect(usesClaudeOnly(launchFromFlags({ chrome: true }))).toBe(true);
    expect(usesClaudeOnly(launchFromFlags({ noCodeMode: true }))).toBe(true);
    expect(usesClaudeOnly(launchFromFlags({ env: ["X=1"] }))).toBe(false);
  });

  test("launchFault checks the shape stored in state", () => {
    expect(launchFault({ env: { A: "1" }, args: ["x"] })).toBeUndefined();
    expect(launchFault({ env: { A: 1 }, args: [] })).toContain("env");
    expect(launchFault({ env: {}, args: "x" })).toContain("args");
    expect(launchFault("x")).toBeDefined();
  });
});

describe("relaunch request", () => {
  const now = 1_000_000;

  test("a fresh request parses; an old or malformed one does not", () => {
    expect(parseRelaunchRequest({ session: "continue", prompt: "/read-handoff", at: now }, now)).toEqual({ session: SessionMode.Continue, prompt: "/read-handoff", at: now });
    expect(parseRelaunchRequest({ session: "continue", prompt: "p", at: now - REQUEST_MAX_AGE_MS - 1 }, now)).toBeUndefined();
    expect(parseRelaunchRequest({ session: "later", prompt: "p", at: now }, now)).toBeUndefined();
    expect(parseRelaunchRequest(null, now)).toBeUndefined();
  });

  test("relaunchExtra resumes only for a continue session", () => {
    expect(relaunchExtra({ session: SessionMode.Continue, prompt: "/read-handoff", at: now })).toEqual(["--continue", "--", "/read-handoff"]);
    expect(relaunchExtra({ session: SessionMode.Fresh, prompt: "/read-handoff", at: now })).toEqual(["--", "/read-handoff"]);
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
    writeRelaunchRequest("ws", { session: SessionMode.Fresh, prompt: "p", at: Date.now() });
    expect(takeRelaunchRequest("ws")?.prompt).toBe("p");
    expect(takeRelaunchRequest("ws")).toBeUndefined();
  });
});
