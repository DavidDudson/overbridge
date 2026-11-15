import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordState, waitingTool } from "../src/agent-hook";
import { agentStatePath, markSubagent, readAgentDetail } from "../src/agent-state";
import { cacheIsStale, durationText, type Entry, entryLines, Section, STALE_CACHE_MS, stateText, workspacesTitle } from "../src/sidebar";

let tmp: string;
let meta: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-detail-"));
  meta = join(tmp, ".overbridge");
  process.env.OVERBRIDGE_ROOT = tmp;
});

afterEach(() => {
  savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
  rmSync(tmp, { recursive: true, force: true });
});

const card = (over: Partial<Entry> = {}): Entry => ({ tab: "w", section: Section.Workspaces, glyph: "·", label: "w", ...over });

describe("durationText", () => {
  test("seconds, minutes with seconds, minutes, hours", () => {
    expect([0, 59_000, 252_000, 600_000, 3_599_000, 3_900_000].map((ms) => durationText(ms))).toEqual(["0s", "59s", "4m12s", "10m", "59m", "1h05m"]);
  });
});

describe("stateText", () => {
  const now = 10_000_000;
  test("working shows elapsed time and agent count", () => {
    expect(stateText(card({ state: "busy", since: now - 252_000, agents: 3 }), now).text).toBe("working 4m12s · 3 agents");
    expect(stateText(card({ state: "busy", since: now - 5_000, agents: 1 }), now).text).toBe("working 5s · 1 agent");
  });
  test("waiting shows the tool, and time only from a minute", () => {
    expect(stateText(card({ state: "waiting", since: now - 120_000, tool: "Bash" }), now).text).toBe("needs input 2m · Bash");
    expect(stateText(card({ state: "waiting", since: now - 10_000 }), now).text).toBe("needs input");
  });
  test("finished with background tasks counts them", () => {
    expect(stateText(card({ state: "bg", since: now - 180_000, agents: 2 }), now).text).toBe("finished · 2 tasks running 3m");
  });
  test("a finish shows time from exactly one minute, in whole minutes", () => {
    expect(stateText(card({ state: "done", since: now - 59_999 }), now).text).toBe("finished");
    expect(stateText(card({ state: "done", since: now - 60_000 }), now).text).toBe("finished 1m");
    expect(stateText(card({ state: "done", since: now - 3_900_000 }), now).text).toBe("finished 1h05m");
  });
  test("no detail without a recorded start", () => {
    expect(stateText(card({ state: "busy" }), now).text).toBe("working");
  });
});

describe("workspacesTitle", () => {
  test("counts attention states in the workspaces section only", () => {
    const l = [card({ state: "waiting" }), card({ state: "done" }), card({ state: "busy" }), card({ state: "waiting", section: Section.Orchestration })];
    expect(workspacesTitle(l)).toBe("Workspaces · 2 need you");
    expect(workspacesTitle([card({ state: "busy" })])).toBe("Workspaces");
  });
});

describe("stale cache", () => {
  test("dims only past the threshold, never for a missing cache", () => {
    expect(cacheIsStale(1000, 1000 + STALE_CACHE_MS)).toBe(false);
    expect(cacheIsStale(1000, 1001 + STALE_CACHE_MS)).toBe(true);
    expect(cacheIsStale(0, 1e12)).toBe(false);
    expect(cacheIsStale(undefined, 1e12)).toBe(false);
  });
  test("a stale card renders dim", () => {
    expect(entryLines(card({ stale: true }), 0, false, 20).every((l) => l.includes("\x1b[2m"))).toBe(true);
    expect(entryLines(card(), 0, false, 20).some((l) => l.includes("\x1b[2m"))).toBe(false);
  });
});

describe("hook record", () => {
  test("since survives rewrites of the same state and resets on a change", () => {
    recordState(meta, "w", "busy", 1000);
    recordState(meta, "w", "busy", 5000);
    expect(readAgentDetail("w", 6000)?.since).toBe(1000);
    recordState(meta, "w", "waiting", 7000, [], undefined, "Bash");
    const d = readAgentDetail("w", 8000);
    expect(d).toMatchObject({ state: "waiting", since: 7000, tool: "Bash", agents: 0 });
  });
  test("tool shows only with waiting", () => {
    recordState(meta, "w", "busy", 1000, [], undefined, "Bash");
    expect(readAgentDetail("w", 2000)?.tool).toBeUndefined();
  });
  test("an old record without since falls back to at", () => {
    mkdirSync(join(meta, "agent"), { recursive: true });
    writeFileSync(agentStatePath(meta, "w"), JSON.stringify({ state: "busy", at: 4000 }));
    expect(readAgentDetail("w", 5000)?.since).toBe(4000);
  });
  test("agents counts subagents and live background shells", () => {
    recordState(meta, "w", "done", Date.now(), [111, 222]);
    markSubagent(meta, "w", "a1");
    expect(readAgentDetail("w", Date.now(), (p) => p === 111)).toMatchObject({ state: "bg", agents: 2 });
  });
  test("waitingTool reads the payload, else the prompt message", () => {
    expect(waitingTool({ tool_name: "Edit" })).toBe("Edit");
    expect(waitingTool({ message: "Claude needs your permission to use Bash" })).toBe("Bash");
    expect(waitingTool({ message: "Claude is waiting for your input" })).toBeUndefined();
  });
  test("a tool name with control characters is dropped, by the hook and by the reader", () => {
    expect(waitingTool({ tool_name: "Ba\x1b[2Jsh" })).toBeUndefined();
    mkdirSync(join(meta, "agent"), { recursive: true });
    writeFileSync(agentStatePath(meta, "w"), JSON.stringify({ state: "waiting", at: Date.now(), tool: "Ba\x1b]0;x\x07sh" }));
    expect(readAgentDetail("w")?.tool).toBeUndefined();
  });
  test("the hook records the tool only for a wait", () => {
    const run = (input: object) => Bun.spawnSync({ cmd: [process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "hook"], env: { ...process.env, OVERBRIDGE_ROOT: tmp, OVERBRIDGE_NAME: "w", OVERBRIDGE_SELF: "true" }, stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
    run({ hook_event_name: "PermissionRequest", tool_name: "Bash" });
    expect(readAgentDetail("w")).toMatchObject({ state: "waiting", tool: "Bash" });
    run({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    expect(JSON.parse(readFileSync(agentStatePath(meta, "w"), "utf8")).tool).toBeUndefined();
  });
});
