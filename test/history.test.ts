import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordHistory } from "../src/agent-hook";
import { type ClaudeEvent, classifyCommand, type CommandClass, claudeRecord, type ClaudeRecord, fileStore, type HistoryRecord, summarize } from "../src/history";
import { duration, summaries, summaryLines } from "../src/history-report";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "overbridge-history-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ev = (at: number, event: ClaudeEvent, extra: Partial<ClaudeRecord> = {}): ClaudeRecord => ({ kind: "claude", at, event, ...extra });
const S = 1000;

describe("classifyCommand", () => {
  test.each<[string, CommandClass]>([
    ["bun test test/foo.test.ts", "test"],
    ["just check", "other"],
    ["tsc --noEmit", "typecheck"],
    ["eslint src", "lint"],
    ["nix build .#x", "build"],
    ["git status", "git"],
    ["prettier --write .", "format"],
  ])("%s is %s", (command, cls) => expect(classifyCommand(command)).toBe(cls));
});

describe("claudeRecord", () => {
  test("keeps tool name, id and the class of a Bash command, never its text", () => {
    const r = claudeRecord({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "bun test --secret=hunter2" } }, 5);
    expect(r).toEqual({ kind: "claude", at: 5, event: "PreToolUse", tool: "Bash", id: "t1", cls: "test" });
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });
  test("ignores events that are not recorded", () => {
    expect(claudeRecord({ hook_event_name: "PreCompact" })).toBeUndefined();
    expect(claudeRecord({})).toBeUndefined();
  });
});

describe("fileStore", () => {
  test("appends, reads since a time, and lists workspaces", () => {
    const store = fileStore(dir);
    store.append("a", ev(1, "SessionStart"));
    store.append("a", ev(10, "Stop"));
    store.append("@root", ev(3, "Stop"));
    expect(store.read("a").map((r) => r.at)).toEqual([1, 10]);
    expect(store.read("a", 5).map((r) => r.at)).toEqual([10]);
    expect(store.read("missing")).toEqual([]);
    expect(store.workspaces()).toEqual(["@root", "a"]);
  });
  test("skips a torn line", () => {
    const store = fileStore(dir);
    store.append("a", ev(1, "Stop"));
    appendFileSync(join(dir, "a.jsonl"), '{"kind":"cla\n');
    store.append("a", ev(2, "Stop"));
    expect(store.read("a")).toHaveLength(2);
  });
  test("cuts a file past its cap to the newest half", () => {
    const store = fileStore(dir, 300);
    for (let i = 0; i < 20; i++) store.append("a", ev(i, "Stop"));
    const at = store.read("a").map((r) => r.at);
    expect(at.at(-1)).toBe(19);
    expect(at.length).toBeLessThan(20);
    expect(readFileSync(join(dir, "a.jsonl"), "utf8").length).toBeLessThan(600);
  });
  test("a history fault never reaches the hook", () => {
    const broken = { append: () => { throw new Error("disk full"); }, read: () => [], workspaces: () => [] };
    expect(() => recordHistory("a", { hook_event_name: "Stop" }, broken)).not.toThrow();
  });
});

describe("summarize", () => {
  const turn: HistoryRecord[] = [
    ev(0, "SessionStart"),
    ev(0, "UserPromptSubmit"),
    ev(10 * S, "PreToolUse", { tool: "Bash", id: "a", cls: "test" }),
    ev(40 * S, "PostToolUse", { tool: "Bash", id: "a", cls: "test" }),
    ev(50 * S, "PreToolUse", { tool: "Edit", id: "b" }),
    ev(60 * S, "Notification"),
    ev(80 * S, "PostToolUse", { tool: "Edit", id: "b" }),
    ev(100 * S, "Stop"),
    ev(160 * S, "UserPromptSubmit"),
    ev(170 * S, "Stop"),
  ];

  test("splits a turn into model, tool, permission and user time", () => {
    const s = summarize(turn);
    expect(s.turns).toBe(2);
    expect(s.turnMs).toBe(110 * S);
    expect(s.toolMs).toBe((30 + 10) * S);
    expect(s.permissionMs).toBe(20 * S);
    expect(s.userMs).toBe(60 * S);
    expect(s.modelMs).toBe(110 * S - 40 * S - 20 * S);
    expect(s.tools.Bash).toEqual({ count: 1, ms: 30 * S });
    expect(s.bash.test).toEqual({ count: 1, ms: 30 * S });
  });
  test("a long gap is away, not waiting", () => {
    const s = summarize([ev(0, "UserPromptSubmit"), ev(S, "Stop"), ev(10 * 3600 * S, "UserPromptSubmit"), ev(10 * 3600 * S + S, "Stop")]);
    expect(s.userMs).toBe(0);
    expect(s.awayMs).toBe(10 * 3600 * S - S);
  });
  test("an idle notification after the turn waits on nobody; records may arrive unsorted", () => {
    const s = summarize([ev(100, "Notification"), ev(50, "Stop"), ev(0, "UserPromptSubmit")]);
    expect(s.permissionMs).toBe(0);
    expect(s.turnMs).toBe(50);
  });
  test("a tool with no post (blocked or killed) is dropped at the next stop", () => {
    const s = summarize([ev(0, "UserPromptSubmit"), ev(1, "PreToolUse", { tool: "Bash", id: "x" }), ev(9, "Stop")]);
    expect(s.toolMs).toBe(0);
    expect(s.modelMs).toBe(9);
  });
  test("counts check runs by class, with failures and queue time", () => {
    const s = summarize([
      { kind: "check", at: 1, repo: "r", command: "bun test", cls: "test", queuedMs: 100, runMs: 4000, exit: 0 },
      { kind: "check", at: 2, repo: "r", command: "bun test", cls: "test", queuedMs: 50, runMs: 2000, exit: 1 },
    ]);
    expect(s.checks.test).toEqual({ count: 2, ms: 6000, failed: 1, queuedMs: 150 });
  });
});

describe("report", () => {
  test("duration", () => {
    expect([duration(120), duration(3400), duration(45_000), duration(252_000), duration(3_900_000)]).toEqual(["120ms", "3.4s", "45s", "4m12s", "1h05m"]);
  });
  test("summaries respect the window and name; lines mention the split", () => {
    const store = fileStore(dir);
    store.append("a", ev(0, "UserPromptSubmit"));
    store.append("a", ev(1000, "Stop"));
    store.append("b", ev(1, "Stop"));
    expect(summaries(store, undefined, "a")).toHaveLength(1);
    expect(summaries(store, 500, undefined, 2000).find((r) => r.ws === "a")?.summary.turns).toBe(0);
    const text = summaryLines(summaries(store, undefined, "a")[0]!).join("\n");
    expect(text).toContain("a: 1 turn");
    expect(text).toContain("model");
  });
});
