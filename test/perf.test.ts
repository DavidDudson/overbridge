import { describe, expect, test } from "bun:test";
import { summarize, type HistoryRecord } from "../src/history";
import type { WorkspaceSummary } from "../src/history-report";
import { ranked, renderPerf } from "../src/perf-run";
import { orchestrationTab } from "../src/orchestration";
import { legend, PERF_KEY, PERF_TAB } from "../src/sidebar";

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
const rec = (at: number, event: "UserPromptSubmit" | "Stop"): HistoryRecord => ({ kind: "claude", at, event });
const ws = (name: string, turnMs: number, checks: HistoryRecord[] = []): WorkspaceSummary => ({
  ws: name,
  summary: summarize([rec(0, "UserPromptSubmit"), rec(turnMs, "Stop"), ...checks]),
});
const check: HistoryRecord = { kind: "check", at: 5, repo: "r", command: "bun test", cls: "test", queuedMs: 0, runMs: 90_000, exit: 1 };

describe("perf tab", () => {
  test("is an orchestration tab running the perf pane, reached by `p`", () => {
    expect(orchestrationTab("@perf")).toMatchObject({ pane: "perf" });
    expect(PERF_KEY).toBe("p");
    expect(PERF_TAB).toBe("@perf");
    expect(legend(3)).toContain("p perf");
  });

  test("ranks the busiest workspace first, then by name", () => {
    expect(ranked([ws("b", 10), ws("a", 10), ws("c", 5000)]).map((r) => r.ws)).toEqual(["c", "a", "b"]);
  });

  test("renders a row per workspace, the selection's checks, and fits the frame", () => {
    const rows = renderPerf([ws("alpha", 120_000, [check]), ws("beta", 1000)], 0, 0, 20, 100, "24h").map(strip);
    expect(rows[0]).toContain("Performance · 24h");
    expect(rows.some((r) => r.includes("alpha") && r.includes("2m00s"))).toBe(true);
    expect(rows.some((r) => r.includes("checks") && r.includes("test 1× 1m30s") && r.includes("(1 failed)"))).toBe(true);
    expect(rows.at(-1)).toContain("2 workspaces");
    expect(rows.length).toBe(20);
  });

  test("says so when there is no history", () => {
    expect(renderPerf([], 0, 0, 12, 80, "1h").map(strip).join("\n")).toContain("no history yet");
  });

  test("scrolls to the offset", () => {
    const list = Array.from({ length: 10 }, (_, i) => ws(`w${i}`, 1000 - i));
    const text = renderPerf(list, 7, 6, 10, 80, "all").map(strip).join("\n");
    expect(text).toContain("w7");
    expect(text).not.toContain("w0");
  });
});
