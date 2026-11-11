import { describe, expect, test } from "bun:test";
import { githubRows, MAX_PAGES, nextCursor, rowsFromGraphql, slugFromUrl } from "../src/pm/board-github";

const reply = JSON.stringify({
  data: {
    repository: {
      issues: {
        nodes: [
          {
            number: 2, title: "two", url: "u2", updatedAt: "2026-01-02T00:00:00Z",
            labels: { nodes: [{ name: "In Progress" }, { name: "p1" }] },
            parent: { number: 1 },
            blockedBy: { nodes: [{ number: 5, state: "OPEN" }, { number: 6, state: "CLOSED" }] },
          },
          { number: 3, title: "three", url: "u3", updatedAt: "2026-01-03T00:00:00Z", labels: { nodes: [] }, parent: null, blockedBy: { nodes: [] } },
        ],
      },
    },
  },
});

describe("github board", () => {
  test("maps labels to status, keeps only open blockers, keys by repo#id", () => {
    const [a, b] = rowsFromGraphql(reply, "ob");
    expect(a).toMatchObject({ repo: "ob", id: "2", status: "in-progress", labels: ["In Progress", "p1"], parent: "ob#1", blockedBy: ["ob#5"] });
    expect(b).toMatchObject({ id: "3", status: "todo", blockedBy: [] });
    expect(b!.parent).toBeUndefined();
  });

  test("an empty or missing repository gives no rows", () => {
    expect(rowsFromGraphql("{}", "ob")).toEqual([]);
  });

  test("githubRows asks who is signed in, then runs one graphql call", () => {
    const calls: string[][] = [];
    const rows = githubRows("o/r", "ob", (cmd) => {
      calls.push(cmd);
      return cmd[2] === "user" ? { ok: true, stdout: "me\n", stderr: "", code: 0 } : { ok: true, stdout: reply, stderr: "", code: 0 };
    });
    expect(rows).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("login=me");
    expect(calls[1]).toContain("owner=o");
  });

  test("a failing call throws with gh's message", () => {
    const fail = () => ({ ok: false, stdout: "", stderr: "boom", code: 1 });
    expect(() => githubRows("o/r", "ob", fail)).toThrow("boom");
  });

  test("slug from ssh and https remotes", () => {
    expect(slugFromUrl("git@github.com:DavidDudson/overbridge.git")).toBe("DavidDudson/overbridge");
    expect(slugFromUrl("https://github.com/a/b")).toBe("a/b");
    expect(slugFromUrl("git@gitlab.com:a/b.git")).toBeUndefined();
  });

  const page = (n: number, next?: string) =>
    JSON.stringify({
      data: { repository: { issues: { pageInfo: { hasNextPage: !!next, endCursor: next ?? null }, nodes: [{ number: n, title: `t${n}`, url: `u${n}`, updatedAt: "2026-01-01T00:00:00Z", labels: { nodes: [] }, parent: null, blockedBy: { nodes: [] } }] } } },
    });
  const ok = (stdout: string) => ({ ok: true, stdout, stderr: "", code: 0 });

  test("nextCursor is the end cursor only while another page exists", () => {
    expect(nextCursor(page(1, "c1"))).toBe("c1");
    expect(nextCursor(page(1))).toBeUndefined();
    expect(nextCursor("{}")).toBeUndefined();
  });

  test("reads every page, passing each end cursor as `after`", () => {
    const replies = [page(1, "c1"), page(2, "c2"), page(3)];
    const calls: string[][] = [];
    const rows = githubRows("o/r", "ob", (cmd) => {
      calls.push(cmd);
      return cmd[2] === "user" ? ok("me") : ok(replies.shift()!);
    });
    expect(rows.map((r) => r.id)).toEqual(["1", "2", "3"]);
    expect(calls.filter((c) => c.includes("graphql"))).toHaveLength(3);
    expect(calls[1]).not.toContain("after=c1");
    expect(calls[2]).toContain("after=c1");
    expect(calls[3]).toContain("after=c2");
  });

  test("a page that fails midway fails the whole read", () => {
    let n = 0;
    expect(() => githubRows("o/r", "ob", (cmd) => (cmd[2] === "user" ? ok("me") : ++n === 1 ? ok(page(1, "c1")) : { ok: false, stdout: "", stderr: "rate limit", code: 1 }))).toThrow("rate limit");
  });

  test("a cursor that never ends stops at the page cap", () => {
    expect(() => githubRows("o/r", "ob", (cmd) => (cmd[2] === "user" ? ok("me") : ok(page(1, "again"))))).toThrow(`more than ${MAX_PAGES * 100}`);
  });
});
