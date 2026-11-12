import { describe, expect, test } from "bun:test";
import { rank, type WorkRow } from "../src/pm/worklist";
import { detailLines, filterRanked, matchesFilter } from "../src/pm/worklist-filter";
import { renderDetail, renderWorklist } from "../src/worklist-run";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const row = (id: string, o: Partial<WorkRow> = {}): WorkRow => ({ repo: "ob", id, title: `title ${id}`, url: `https://x/${id}`, status: "todo", labels: [], blockedBy: [], updatedAt: `2026-01-0${id}T00:00:00Z`, ...o });
const list = rank([row("1", { title: "Fix login", labels: ["bug", "area:auth"] }), row("2", { blockedBy: ["ob#1"], title: "Add logout" }), row("3", { status: "in-progress", title: "Docs", labels: ["docs"] }), row("4", { title: "Unrelated" })]);
const keys = (q: string) => filterRanked(list, q).map((i) => i.key);

describe("filter", () => {
  test("empty query keeps everything in rank order", () => {
    expect(keys("")).toEqual(list.map((i) => i.key));
    expect(keys("   ")).toEqual(list.map((i) => i.key));
  });
  test("text matches title and key, case-insensitively, all terms required", () => {
    expect(keys("LOG")).toEqual(expect.arrayContaining(["ob#1", "ob#2"]));
    expect(keys("log")).toHaveLength(2);
    expect(keys("log zzz")).toEqual([]);
    expect(keys("ob#3")).toEqual(["ob#3"]);
  });
  test("label:, status: and stream filters", () => {
    expect(keys("label:bug")).toEqual(["ob#1"]);
    expect(keys("label:BU")).toEqual(["ob#1"]);
    expect(keys("status:in-progress")).toEqual(["ob#3"]);
    const stream = list.find((i) => i.key === "ob#2")!.stream;
    expect(keys(`stream:${stream}`).sort()).toEqual(["ob#1", "ob#2"]);
    expect(keys(`s${stream}`).sort()).toEqual(["ob#1", "ob#2"]);
    expect(keys("label:bug stream:99")).toEqual([]);
  });
  test("a field with no value falls back to text", () => {
    expect(matchesFilter(list[0]!, "label:")).toBe(false);
  });
});

describe("detail", () => {
  test("shows reasons, blockers with their state, and the link", () => {
    const item = list.find((i) => i.key === "ob#2")!;
    const text = detailLines(item, list).join("\n");
    expect(text).toContain("why: waiting on blockers");
    expect(text).toContain("blocked by:\n  ob#1 Fix login (todo)");
    expect(text).toContain("link: https://x/2");
  });
  test("a blocker off the list is assumed open; none says so", () => {
    expect(detailLines(list.find((i) => i.key === "ob#4")!, list).join("\n")).toContain("blocked by: nothing");
    const orphan = rank([row("5", { blockedBy: ["ob#9"] })])[0]!;
    expect(detailLines(orphan, [orphan]).join("\n")).toContain("ob#9 (not on the list, assumed open)");
  });
  test("renders to the exact height and fits the width", () => {
    const rows = renderDetail(list[0]!, list, 14, 60);
    expect(rows).toHaveLength(14);
    expect(rows.every((r) => strip(r).length <= 60)).toBe(true);
  });
  test("the list view names the filter, and an empty match says so", () => {
    const text = renderWorklist([], 0, 0, 12, 70, "", [], "zzz").map(strip).join("\n");
    expect(text).toContain("nothing matches /zzz");
    expect(text).toContain("0 match /zzz");
  });
});
