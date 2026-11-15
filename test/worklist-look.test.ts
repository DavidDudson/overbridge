import { describe, expect, test } from "bun:test";
import { filterBoardsByOrg, type BoardSource } from "../src/worklist-data";
import { workAnimated, workHealth, workInput, statusGlyph } from "../src/worklist-look";
import { badgeOf } from "../src/tab-badge";
import { prBadgeFromCache, workBadgeFromCache } from "../src/my-badges";

describe("work list look", () => {
  test("status maps to the shared health looks", () => {
    expect(workHealth({ status: "blocked", ready: false })).toBe("changes");
    expect(workHealth({ status: "in-progress", ready: false })).toBe("waiting");
    expect(workHealth({ status: "todo", ready: true })).toBe("ready");
    expect(workHealth({ status: "todo", ready: false })).toBe("draft");
  });
  test("an item in progress spins; others keep a fixed glyph", () => {
    const a = statusGlyph({ status: "in-progress", ready: false }, 0).icon;
    const b = statusGlyph({ status: "in-progress", ready: false }, 100).icon;
    expect(a).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/);
    expect(a).not.toBe(b);
    expect(statusGlyph({ status: "blocked", ready: false }, 0)).toEqual(statusGlyph({ status: "blocked", ready: false }, 900));
    expect(workAnimated([{ status: "todo", ready: true }])).toBe(false);
    expect(workAnimated([{ status: "in-progress", ready: false }])).toBe(true);
  });
  test("the badge counts items and lists the worst first", () => {
    const b = badgeOf([workInput({ status: "todo", ready: true }), workInput({ status: "blocked", ready: false }), workInput({ status: "in-progress", ready: false })]);
    expect(b).toEqual({ count: 3, icons: ["changes", "waiting", "ready"] });
  });
});

describe("org filter", () => {
  const gh = (slug: string): BoardSource => ({ kind: "github", repo: slug.split("/")[1]!, slug });
  const jira: BoardSource = { kind: "jira", project: "ENG", repos: ["x"] };

  test("keeps boards owned by a listed org, any case, and every Jira source", () => {
    const out = filterBoardsByOrg([gh("DavidDudson/a"), gh("other/b"), jira], ["daviddudson"]);
    expect(out.map((s) => (s.kind === "github" ? s.slug : s.project))).toEqual(["DavidDudson/a", "ENG"]);
  });
  test("no orgs keeps everything", () => {
    expect(filterBoardsByOrg([gh("other/b")], [])).toHaveLength(1);
  });
});

describe("badge cache parsers", () => {
  const work = (o: { id?: string; status?: string }) => ({ repo: "ob", id: "1", title: "t", url: "u", status: "todo", labels: [], blockedBy: [], updatedAt: "2026-01-01T00:00:00Z", ...o });

  test("work: counts open valid rows, skips done and malformed", () => {
    const b = workBadgeFromCache({ rows: [work({}), work({ id: "2", status: "done" }), work({ id: "3", status: "blocked" }), { junk: true }] });
    expect(b).toEqual({ count: 2, icons: ["changes", "ready"] });
  });
  test("work: a file without rows has no badge", () => {
    expect(workBadgeFromCache({})).toBeUndefined();
    expect(workBadgeFromCache("x")).toBeUndefined();
  });
  test("prs: conflict first, unknown ci ignored, malformed row skipped", () => {
    const b = prBadgeFromCache({ rows: [{ draft: false, ci: "success", mergeable: "MERGEABLE" }, { draft: false, mergeable: "CONFLICTING", ci: "bogus" }, 7] });
    expect(b).toEqual({ count: 2, icons: ["conflict", "ready"] });
    expect(prBadgeFromCache({})).toBeUndefined();
  });
  test("done maps to ready", () => {
    expect(workHealth({ status: "done", ready: false })).toBe("ready");
  });
});
