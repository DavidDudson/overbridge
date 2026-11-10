import { describe, expect, test } from "bun:test";
import { appendCleanup, CleanupCause, CLEANUP_LOG_LIMIT, CLEANUP_ROWS, CleanupOutcome, type CleanupRecord, cleanupRows, secondsToCheck } from "../src/cleanup-log";
import { renderSidebar, Section } from "../src/sidebar";

const plain = (rows: string[]) => rows.map((r) => r.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
const MINUTE_MS = 60_000;
const NOW_MS = Date.parse("2026-11-10T12:00:00Z");

const record = (ws: string, agoMs = MINUTE_MS, outcome: CleanupOutcome = CleanupOutcome.Removed, cause: CleanupCause = CleanupCause.Cleanup): CleanupRecord => ({
  ws,
  label: `#${ws} fix the thing`,
  atMs: NOW_MS - agoMs,
  outcome,
  cause,
});

describe("appendCleanup", () => {
  test("keeps the newest records only", () => {
    const log = Array.from({ length: CLEANUP_LOG_LIMIT }, (_, i) => record(String(i)));
    const out = appendCleanup(log, record("new"));
    expect(out).toHaveLength(CLEANUP_LOG_LIMIT);
    expect(out[0]!.ws).toBe("1");
    expect(out.at(-1)!.ws).toBe("new");
  });
});

describe("secondsToCheck", () => {
  test("counts down from the last check and stops at zero", () => {
    expect(secondsToCheck(NOW_MS - 20_000, NOW_MS)).toBe(40);
    expect(secondsToCheck(NOW_MS - 61_000, NOW_MS)).toBe(0);
    expect(secondsToCheck(undefined, NOW_MS)).toBe(0);
  });
});

describe("cleanupRows", () => {
  const lastCheck = NOW_MS - 30_000;

  test("only the countdown when nothing is being removed", () => {
    expect(plain(cleanupRows([], [], 40, NOW_MS, lastCheck))).toEqual(["🧹 next check 30s"]);
  });

  test("in-flight removals first, then finished ones newest first, no ages", () => {
    const rows = cleanupRows([{ label: "#9 tidy", sinceMs: NOW_MS - 4_000 }], [record("12", 20_000), record("7", 10_000, CleanupOutcome.Failed)], 40, NOW_MS, lastCheck);
    expect(plain(rows)).toEqual(["🧹 next check 30s", "🧹 removing #9 tidy", "✗ failed #7 fix the thing", "🧹 removed #12 fix the thing"]);
  });

  test("a removal finished before the last check is gone", () => {
    expect(plain(cleanupRows([], [record("old", 40_000)], 40, NOW_MS, lastCheck))).toEqual(["🧹 next check 30s"]);
  });

  test("a failure is red, a removal grey, one in flight yellow", () => {
    const [, running, failed, removed] = cleanupRows([{ label: "a", sinceMs: NOW_MS }], [record("b", 5_000, CleanupOutcome.Failed), record("c", 10_000)], 40, NOW_MS, lastCheck);
    expect(running).toContain("\x1b[33m");
    expect(failed).toContain("\x1b[31m");
    expect(removed).toContain("\x1b[38;5;245m");
  });

  test(`at most ${CLEANUP_ROWS} removal rows, each cut to the width`, () => {
    const log = Array.from({ length: 5 }, (_, i) => record(String(i), (i + 1) * 1_000));
    const rows = plain(cleanupRows([], log, 20, NOW_MS, lastCheck));
    expect(rows).toHaveLength(CLEANUP_ROWS + 1);
    expect(rows[1]!.endsWith("…")).toBe(true);
  });

  test("the rows sit under the divider and the frame keeps its height", () => {
    const list = [{ tab: "1", section: Section.Workspaces, glyph: "·", label: "one" }];
    const rows = renderSidebar(list, 0, 0, 20, 40, undefined, 0, "", cleanupRows([], [record("12", 5_000)], 36, NOW_MS, lastCheck));
    expect(rows).toHaveLength(20);
    expect(rows.findIndex((r) => r.includes("removed #12"))).toBeGreaterThan(rows.findIndex((r) => r.includes("├")));
  });
});
