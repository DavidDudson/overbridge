import { describe, expect, test } from "bun:test";
import { sortPrRows } from "../src/pr-sort";
import type { PrRow } from "../src/pr-rows";
import { Section, sortEntries, workspacesTitle, type Entry } from "../src/sidebar";
import { nextSort, sortBy, SORT_MODES } from "../src/sort-mode";

const card = (tab: string, over: Partial<Entry> = {}): Entry => ({ tab, section: Section.Workspaces, glyph: "●", label: tab, ...over });
const names = (list: readonly { tab: string }[]) => list.map((e) => e.tab);

describe("sort mode", () => {
  test("cycles through every mode and wraps", () => {
    expect(SORT_MODES.map((m) => nextSort(m))).toEqual(["status", "age", "alpha"]);
  });
  test("every mode ends in the name, so ties never reshuffle", () => {
    const same = [{ n: "b" }, { n: "a" }, { n: "c" }];

    for (const mode of SORT_MODES) {
      expect(sortBy(same, mode, (x) => ({ name: x.n, rank: 0, since: undefined })).map((x) => x.n)).toEqual(["a", "b", "c"]);
    }
  });
  test("names sort naturally", () => {
    expect(names(sortEntries([card("ws10"), card("ws2"), card("ws1")], "alpha"))).toEqual(["ws1", "ws2", "ws10"]);
  });
});

describe("sidebar order", () => {
  const list = [
    card("@root", { section: Section.Orchestration }),
    card("zed", { state: "busy", since: 100 }),
    card("amy", { state: "idle", since: 50 }),
    card("bob", { state: "waiting", since: 300 }),
    card("cat", { fault: "bad cache" }),
    card("dan"),
  ];

  test("orchestration tabs stay first in every mode", () => {
    for (const mode of SORT_MODES) expect(sortEntries(list, mode)[0]!.tab).toBe("@root");
  });
  test("alphabetical", () => {
    expect(names(sortEntries(list, "alpha"))).toEqual(["@root", "amy", "bob", "cat", "dan", "zed"]);
  });
  test("status: faults, then agents that want you, then busy, then the rest", () => {
    expect(names(sortEntries(list, "status"))).toEqual(["@root", "cat", "bob", "zed", "amy", "dan"]);
  });
  test("age: longest in its state first, no time last", () => {
    expect(names(sortEntries(list, "age"))).toEqual(["@root", "amy", "zed", "bob", "cat", "dan"]);
  });
  test("an entry with an error ranks with the faults", () => {
    expect(names(sortEntries([card("amy"), card("eve", { error: "x" })], "status"))).toEqual(["eve", "amy"]);
  });
  test("the title names a non-default mode, and is unchanged without one", () => {
    expect(workspacesTitle(list)).toBe(workspacesTitle(list, undefined));
    expect(workspacesTitle(list, "age")).toContain("by age");
  });
  test("input order does not matter and the input is not changed", () => {
    const before = names(list);
    expect(names(sortEntries(list.toReversed(), "status"))).toEqual(names(sortEntries(list, "status")));
    expect(names(list)).toEqual(before);
  });
});

describe("review order", () => {
  const row = (repo: string, number: number, over: Partial<PrRow> = {}): PrRow => ({ repo, number, title: "t", url: `u/${repo}/${number}`, author: "a", draft: false, updatedAt: "2026-11-10T00:00:00Z", ...over });

  const rows = [
    row("o/b", 2, { ci: "success", updatedAt: "2026-10-01T00:00:00Z" }),
    row("o/a", 10, { mergeable: "CONFLICTING", updatedAt: "2026-11-11T00:00:00Z" }),
    row("o/a", 9, { draft: true, updatedAt: "2026-11-01T00:00:00Z" }),
    row("o/c", 1, { ci: "failure", updatedAt: "garbage" }),
  ];

  const keys = (list: PrRow[]) => list.map((r) => `${r.repo}#${r.number}`);

  test("alphabetical by repo then number", () => {
    expect(keys(sortPrRows(rows, "alpha"))).toEqual(["o/a#9", "o/a#10", "o/b#2", "o/c#1"]);
  });
  test("status puts conflicts first", () => {
    expect(keys(sortPrRows(rows, "status"))[0]).toBe("o/a#10");
  });
  test("status ranks a failing build ahead of a draft and a green build, whatever the names", () => {
    expect(keys(sortPrRows(rows, "status")).indexOf("o/c#1")).toBeLessThan(keys(sortPrRows(rows, "status")).indexOf("o/a#9"));
    expect(keys(sortPrRows(rows, "status")).indexOf("o/a#9")).toBeLessThan(keys(sortPrRows(rows, "status")).indexOf("o/b#2"));
  });
  test("age puts the longest waiting first and an unreadable date last", () => {
    expect(keys(sortPrRows(rows, "age"))).toEqual(["o/b#2", "o/a#9", "o/a#10", "o/c#1"]);
  });
});
