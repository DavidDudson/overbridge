import { describe, expect, test } from "bun:test";
import { age, readPrs, renderPrList, rowsFromSearch, searchCommand } from "../src/prlist-run";

const hit = { number: 7, title: "Fix", url: "https://github.com/o/r/pull/7", repository: { nameWithOwner: "o/r" }, author: { login: "a" }, isDraft: false, updatedAt: "2026-11-11T00:00:00Z" };

describe("pr lists", () => {
  test("search command scopes to orgs and the list kind", () => {
    const mine = searchCommand("prs", ["DavidDudson", "megaport"]);
    expect(mine).toContain("--author=@me");
    expect(mine).toContain("--owner=DavidDudson");
    expect(mine).toContain("--owner=megaport");
    expect(searchCommand("reviews", [])).toContain("--review-requested=@me");
    expect(searchCommand("reviews", []).some((a) => a.startsWith("--owner"))).toBe(false);
  });
  test("rows from gh output", () => {
    expect(rowsFromSearch(JSON.stringify([hit]))[0]).toMatchObject({ repo: "o/r", number: 7, author: "a", draft: false });
  });
  test("failed gh throws its first line", () => {
    expect(() => readPrs("prs", [], () => ({ ok: false, code: 1, stdout: "", stderr: "boom\nmore" }))).toThrow("boom");
  });
  test("age", () => {
    const now = Date.parse("2026-11-11T03:00:00Z");
    expect(age("2026-11-11T00:00:00Z", now)).toBe("3h");
    expect(age("nope", now)).toBe("");
  });
  test("render marks selection and empty state", () => {
    expect(renderPrList("reviews", [], 0, 0, 10, 80).join("\n")).toContain("no reviews waiting on you");
    expect(renderPrList("prs", rowsFromSearch(JSON.stringify([hit])), 0, 0, 10, 80).join("\n")).toContain("o/r");
  });
});
