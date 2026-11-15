import { describe, expect, test } from "bun:test";
import { claudeRecord, type HistoryRecord, summarize } from "../src/history";
import { commandRows, mergeSummaries } from "../src/history-report";
import { listCommands, nextView, renderCommands, renderDashboard, VIEWS } from "../src/perf-views";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

const call = (at: number, ms: number, id: string, tool: string, extra: Partial<HistoryRecord> = {}, fail = false): HistoryRecord[] => [
  { kind: "claude", at, event: "PreToolUse", tool, id, ...extra } as HistoryRecord,
  { kind: "claude", at: at + ms, event: fail ? "PostToolUseFailure" : "PostToolUse", tool, id } as HistoryRecord,
];

const records: HistoryRecord[] = [
  { kind: "claude", at: 0, event: "SessionStart" },
  { kind: "claude", at: 1, event: "UserPromptSubmit" },
  ...call(10, 5000, "a", "Bash", { cls: "test", label: "bun test" }),
  ...call(6000, 100, "b", "Bash", { cls: "git", label: "git status" }),
  ...call(7000, 4000, "c", "Bash", { cls: "test", label: "bun test" }, true),
  ...call(12000, 10, "d", "Skill", { label: "overbridge:ship-pr" }),
  { kind: "claude", at: 20_000, event: "Stop" },
  { kind: "check", at: 30, repo: "r", command: "just check", group: "check", cls: "test", queuedMs: 100, runMs: 60_000, exit: 0 },
];

describe("history labels", () => {
  test("a Bash call keeps its leading words, a Skill call its name, never arguments", () => {
    const b = claudeRecord({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "x", tool_input: { command: "curl -H 'Authorization: s3' https://h" } }, 1);
    expect(b?.label).toBe("curl");
    expect(JSON.stringify(b)).not.toContain("s3");
    expect(claudeRecord({ hook_event_name: "PreToolUse", tool_name: "Skill", tool_use_id: "y", tool_input: { skill: "ship-pr" } }, 1)?.label).toBe("ship-pr");
  });

  test("summarize tallies commands, skills and sessions", () => {
    const s = summarize(records);
    expect(s.sessions).toBe(1);
    expect(s.commands["bun test"]).toMatchObject({ count: 2, ms: 9000, maxMs: 5000, failed: 1, cls: "test" });
    expect(s.skills["overbridge:ship-pr"]!.count).toBe(1);
  });
});

describe("dashboard and commands", () => {
  const s = summarize(records);

  test("mergeSummaries adds workspaces", () => {
    const m = mergeSummaries([s, s]);
    expect(m.turns).toBe(2);
    expect(m.commands["bun test"]!.count).toBe(4);
    expect(m.commands["bun test"]!.maxMs).toBe(5000);
    expect(m.tools.Bash!.count).toBe(6);
  });

  test("commandRows lists Bash and check commands slowest first", () => {
    const rows = commandRows(s);
    expect(rows.map((r) => `${r.source}:${r.label}`)).toEqual(["check:check", "bash:bun test", "bash:git status"]);
  });

  test("filters by source and sorts", () => {
    const rows = commandRows(s);
    expect(listCommands(rows, "check", "time").map((r) => r.label)).toEqual(["check"]);
    expect(listCommands(rows, "bash", "runs")[0]!.label).toBe("bun test");
  });

  test("v cycles dashboard, sessions, commands", () => {
    expect(VIEWS).toEqual(["dashboard", "sessions", "commands"]);
    expect(nextView("commands")).toBe("dashboard");
  });

  test("renders both views to the frame height", () => {
    const d = renderDashboard(s, 1, commandRows(s), 0, 30, 100, "7d").map(strip);
    expect(d.length).toBe(30);
    expect(d.join("\n")).toContain("Time in each tool");
    expect(d.join("\n")).toContain("1 session");
    const c = renderCommands(commandRows(s), 0, 0, 20, 110, "7d", "all", "time").map(strip);
    expect(c.length).toBe(20);
    expect(c.join("\n")).toContain("bun test");
    expect(renderDashboard(summarize([]), 0, [], 0, 12, 80, "1h").map(strip).join("\n")).toContain("no history yet");
  });
});
