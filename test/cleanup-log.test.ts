import { describe, expect, test } from "bun:test";
import { appendCleanup, CleanupCause, CLEANUP_LOG_LIMIT, CLEANUP_ROWS, CLEANUP_SHOW_MS, CleanupOutcome, type CleanupRecord, cleanupRows, shortAge } from "../src/cleanup-log";
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

describe("shortAge", () => {
  test("seconds, then minutes, then hours", () => {
    expect(shortAge(4_000)).toBe("4s");
    expect(shortAge(3 * MINUTE_MS + 30_000)).toBe("3m");
    expect(shortAge(2 * 60 * MINUTE_MS)).toBe("2h");
    expect(shortAge(-5)).toBe("0s");
  });
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

describe("cleanupRows", () => {
  test("nothing when nothing was cleaned up lately", () => {
    expect(cleanupRows([], [], 40, NOW_MS)).toEqual([]);
    expect(cleanupRows([], [record("old", CLEANUP_SHOW_MS)], 40, NOW_MS)).toEqual([]);
  });

  test("in-flight removals first, then finished ones newest first", () => {
    const rows = cleanupRows([{ label: "#9 tidy", sinceMs: NOW_MS - 4_000 }], [record("12", 3 * MINUTE_MS), record("7", MINUTE_MS, CleanupOutcome.Failed)], 40, NOW_MS);
    expect(plain(rows)).toEqual(["🧹 4s removing #9 tidy", "✗ 1m failed #7 fix the thing", "🧹 3m cleaned #12 fix the thing"]);
  });

  test("a removed row names what removed it", () => {
    const log = [record("1", MINUTE_MS, CleanupOutcome.Removed, CleanupCause.Merged), record("2", 2 * MINUTE_MS, CleanupOutcome.Removed, CleanupCause.SessionEnded)];
    expect(plain(cleanupRows([], log, 40, NOW_MS))).toEqual(["🧹 1m merged #1 fix the thing", "🧹 2m exited #2 fix the thing"]);
  });

  test("a failure is red, a removal grey, one in flight yellow", () => {
    const [running, failed, removed] = cleanupRows([{ label: "a", sinceMs: NOW_MS }], [record("b", MINUTE_MS, CleanupOutcome.Failed), record("c", 2 * MINUTE_MS)], 40, NOW_MS);
    expect(running).toContain("\x1b[33m");
    expect(failed).toContain("\x1b[31m");
    expect(removed).toContain("\x1b[38;5;245m");
  });

  test(`at most ${CLEANUP_ROWS} rows, each cut to the width`, () => {
    const log = Array.from({ length: 5 }, (_, i) => record(String(i), (i + 1) * MINUTE_MS));
    const rows = plain(cleanupRows([], log, 20, NOW_MS));
    expect(rows).toHaveLength(CLEANUP_ROWS);
    expect(rows[0]!.endsWith("…")).toBe(true);
  });

  test("the rows sit under the divider and the frame keeps its height", () => {
    const list = [{ tab: "1", section: Section.Workspaces, glyph: "·", label: "one" }];
    const rows = renderSidebar(list, 0, 0, 20, 40, undefined, 0, "", cleanupRows([], [record("12")], 36, NOW_MS));
    expect(rows).toHaveLength(20);
    expect(rows.findIndex((r) => r.includes("cleaned #12"))).toBeGreaterThan(rows.findIndex((r) => r.includes("├")));
  });
});
