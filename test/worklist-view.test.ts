import { describe, expect, test } from "bun:test";
import { rank, type WorkRow } from "../src/pm/worklist";
import { renderWorklist } from "../src/worklist-run";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const row = (id: string, o: Partial<WorkRow> = {}): WorkRow => ({
  repo: "ob",
  id,
  title: `title ${id}`,
  url: `u${id}`,
  status: "todo",
  labels: [],
  blockedBy: [],
  updatedAt: `2026-01-0${id}T00:00:00Z`,
  ...o,
});

describe("renderWorklist", () => {
  const list = rank([row("1", { labels: ["p0"] }), row("2", { blockedBy: ["ob#1"] }), row("3", { status: "in-progress" })]);

  test("rows fit the width and the height", () => {
    const rows = renderWorklist(list, 0, 0, 12, 60);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => strip(r).length <= 60)).toBe(true);
  });

  test("lists items in rank order with readiness, and explains the selected one", () => {
    const rows = renderWorklist(list, 0, 0, 12, 70).map(strip);
    expect(rows[2]).toMatch(/1\s+yes\s+s1\s+ob#1\s+title 1/);
    expect(rows[3]).toMatch(/2\s+no\s+s1\s+ob#2/);
    expect(rows.find((r) => r.includes("why:"))).toContain("ready, priority p0, unblocks 1");
  });

  test("says so when nothing is assigned", () => {
    expect(renderWorklist([], 0, 0, 12, 60).map(strip).join("\n")).toContain("nothing assigned to you");
  });

  test("scrolls with the offset", () => {
    const rows = renderWorklist(list, 2, 1, 8, 70).map(strip);
    expect(rows.join("\n")).toContain("ob#2");
    expect(rows.join("\n")).not.toContain("title 1");
  });
});
