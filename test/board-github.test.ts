import { describe, expect, test } from "bun:test";
import { BOARD_QUERY, boardQuery, githubRows, MAX_PAGES, nextCursor, rowsFromGraphql, slugFromUrl } from "../src/pm/board-github";

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

  const withStatus = (status: string | null | undefined, labels: string[] = []) =>
    JSON.stringify({
      data: { repository: { issues: { nodes: [{ number: 9, title: "t", url: "u", updatedAt: "2026-01-01T00:00:00Z", labels: { nodes: labels.map((name) => ({ name })) }, parent: null, blockedBy: { nodes: [] },
        projectItems: { nodes: [null, { fieldValueByName: null }, { fieldValueByName: status ? { name: status } : null }] } }] } } },
    });
  const statusOf = (reply: string, columns = {}) => rowsFromGraphql(reply, "ob", columns)[0]!.status;

  test("the project Status column sets the status, through the configured map first", () => {
    expect(statusOf(withStatus("Done"))).toBe("done");
    expect(statusOf(withStatus("In review"))).toBe("in-progress");
    expect(statusOf(withStatus("Waiting on vendor"))).toBe("todo");
    expect(statusOf(withStatus("Waiting on vendor"), { "waiting on vendor": "blocked" })).toBe("blocked");
    expect(statusOf(withStatus("Done"), { done: "todo" })).toBe("todo");
  });

  test("a todo column or no column still lets a label speak", () => {
    expect(statusOf(withStatus("Ready", ["blocked"]))).toBe("blocked");
    expect(statusOf(withStatus(null, ["In Progress"]))).toBe("in-progress");
    expect(statusOf(withStatus("Done", ["blocked"]))).toBe("done");
  });

  test("the query asks for the Status field, and githubRows passes the column map on", () => {
    expect(BOARD_QUERY).toContain('fieldValueByName(name:"Status")');
    const rows = githubRows("o/r", "ob", (cmd) => (cmd[2] === "user" ? ok("me") : ok(withStatus("Parked"))), { parked: "blocked" });
    expect(rows[0]!.status).toBe("blocked");
  });

  const issue = (n: number, assignees: number, onBoard: boolean) => ({
    number: n, title: `t${n}`, url: `u${n}`, updatedAt: "2026-01-01T00:00:00Z", labels: { nodes: [] }, parent: null, blockedBy: { nodes: [] },
    assignees: { totalCount: assignees }, projectItems: { nodes: onBoard ? [{ fieldValueByName: { name: "Todo" } }] : [] },
  });
  const mixed = JSON.stringify({ data: { repository: { issues: { nodes: [issue(1, 1, true), issue(2, 0, true), issue(3, 0, false)] } } } });

  test("scope: assigned and all keep every returned issue; unassigned keeps nobody's issues on a board", () => {
    expect(rowsFromGraphql(mixed, "ob", {}, "assigned")).toHaveLength(3);
    expect(rowsFromGraphql(mixed, "ob", {}, "all")).toHaveLength(3);
    expect(rowsFromGraphql(mixed, "ob", {}, "unassigned").map((r) => r.id)).toEqual(["2"]);
  });

  test("only the assigned scope filters on a login, and only it declares $login", () => {
    expect(boardQuery("assigned")).toContain("filterBy:{assignee:$login}");
    expect(boardQuery("assigned")).toContain("$login:String!");
    for (const scope of ["unassigned", "all"] as const) {
      expect(boardQuery(scope)).not.toContain("$login");
      expect(boardQuery(scope)).not.toContain("filterBy");
    }
    expect(BOARD_QUERY).toBe(boardQuery("assigned"));
  });

  test("a non-assigned scope never asks who is signed in", () => {
    const calls: string[][] = [];
    const rows = githubRows("o/r", "ob", (cmd) => { calls.push(cmd); return ok(mixed); }, {}, "all");
    expect(rows).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.join(" ")).not.toContain("login=");
  });
});
