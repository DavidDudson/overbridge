import { describe, expect, test } from "bun:test";
import { ancestorsOf, DEFAULT_WORKLIST_JQL, viewTicket, jiraRows, priorityFromJira, rowsFromJiraRaw, worklistJql } from "../src/pm/board-jira";

const linked = (key: string, status: string, resolution = "") => ({ key, fields: { status: { name: status }, resolution: { name: resolution } } });
const blocks = { name: "Blocks", inward: "is blocked by", outward: "blocks" };
const relates = { name: "Relates", inward: "relates to", outward: "relates to" };

const reply = JSON.stringify([
  {
    key: "ABC-2",
    fields: {
      summary: "two",
      status: { name: "Code Review" },
      priority: { name: "High" },
      issueType: { name: "Story" },
      labels: ["frontend"],
      parent: { key: "ABC-1" },
      updated: "2026-01-02T00:00:00.000+1000",
      issueLinks: [
        { type: blocks, inwardIssue: linked("ABC-5", "Open") },
        { type: blocks, inwardIssue: linked("ABC-6", "Done") },
        { type: blocks, inwardIssue: linked("ABC-7", "Won't Do", "Won't Do") },
        { type: blocks, outwardIssue: linked("ABC-8", "Open") },
        { type: relates, inwardIssue: linked("ABC-9", "Open") },
      ],
    },
  },
  { key: "ABC-3", fields: { summary: "three", status: { name: "Open" }, priority: null, labels: null, parent: null, updated: "2026-01-03T00:00:00.000+1000", issueLinks: null } },
]);

const epic = JSON.stringify({ key: "ABC-1", fields: { summary: "Dark mode", issuetype: { name: "Epic" }, parent: { key: "ABC-100" } } });

const ticket = (key: string, type: string, parent?: string, summary = key) => ({ key, fields: { summary, issueType: { name: type }, parent: parent ? { key: parent } : null } });

describe("epics", () => {
  test("a task names its parent epic; a subtask names its task's epic, from the list or a lookup", () => {
    const list = JSON.stringify([ticket("A-3", "Task", "A-1"), ticket("A-4", "Sub-task", "A-3"), ticket("A-5", "Sub-task", "A-9"), ticket("A-6", "Task")]);
    const ancestors = [ticket("A-1", "Epic", undefined, "Epic one"), ticket("A-9", "Story", "A-2"), ticket("A-2", "epic", undefined, "Epic two")];
    const rows = rowsFromJiraRaw(list, "A", ["web"], undefined, ancestors);
    expect(rows.map((r) => [r.id, r.epic, r.epicTitle])).toEqual([
      ["A-3", "A-1", "Epic one"],
      ["A-4", "A-1", "Epic one"],
      ["A-5", "A-2", "Epic two"],
      ["A-6", undefined, undefined],
    ]);
  });

  test("ancestorsOf reads each parent once, one level at a time, skips what it knows and stops at epics", () => {
    const tickets = new Map([
      ["A-3", ticket("A-3", "Task", "A-1")],
      ["A-8", ticket("A-8", "Epic", "A-50")],
      ["A-1", ticket("A-1", "Epic", "A-50")],
    ]);

    const reads: string[] = [];

    const read = (key: string) => {
      reads.push(key);

      return tickets.get(key);
    };

    const found = ancestorsOf([ticket("A-4", "Sub-task", "A-3"), ticket("A-5", "Task", "A-8"), ticket("A-7", "Task", "A-4"), ticket("A-60", "Epic", "A-50"), ticket("A-9", "Task", "A-404")], read);
    expect(found.map((i) => i.key)).toEqual(["A-3", "A-8", "A-1"]);
    expect(reads).toEqual(["A-3", "A-8", "A-404", "A-1"]);
  });

  test("viewTicket reads with jira issue view, keeps only what the epic lookup needs, and gives undefined on a failure", () => {
    const calls: string[][] = [];
    const raw = JSON.stringify({ key: "A-1", fields: { summary: "Epic one", issuetype: { name: "Epic" }, parent: { key: "A-50" }, description: "long" } });

    const read = viewTicket((cmd) => {
      calls.push(cmd);

      return { ok: cmd[3] === "A-1", stdout: cmd[3] === "A-1" ? raw : "", stderr: "", code: 0 };
    });

    expect(read("A-1")).toEqual({ key: "A-1", fields: { summary: "Epic one", issuetype: { name: "Epic" }, parent: { key: "A-50" } } });
    expect(calls).toEqual([["jira", "issue", "view", "A-1", "--raw"]]);
    expect(read("A-2")).toBeUndefined();
    expect(viewTicket(() => ({ ok: true, stdout: "{nope", stderr: "", code: 0 }))("A-1")).toBeUndefined();
  });
});

describe("jira board", () => {
  test("maps status, priority, parent and only the open tickets blocking this one", () => {
    const [a, b] = rowsFromJiraRaw(reply, "ABC", ["web", "api"], "https://example.atlassian.net/");
    expect(a).toEqual({
      repo: "ABC",
      repos: ["web", "api"],
      id: "ABC-2",
      title: "two",
      url: "https://example.atlassian.net/browse/ABC-2",
      status: "in-progress",
      labels: ["frontend"],
      blockedBy: ["ABC-5"],
      parent: "ABC-1",
      priority: 1,
      type: "Story",
      updatedAt: "2026-01-02T00:00:00.000+1000",
    });
    expect(b).toMatchObject({ id: "ABC-3", status: "todo", labels: [], blockedBy: [] });
    expect(b!.parent).toBeUndefined();
    expect(b!.priority).toBeUndefined();
    expect(b!.type).toBeUndefined();
  });

  test("reads the issue type under Jira REST's `issuetype` spelling too", () => {
    const rest = JSON.stringify([{ key: "ABC-4", fields: { summary: "four", status: { name: "Open" }, issuetype: { name: "Bug" } } }]);
    expect(rowsFromJiraRaw(rest, "ABC", ["web"])[0]!.type).toBe("Bug");
  });

  test("no site means no links, and an empty reply gives no rows", () => {
    expect(rowsFromJiraRaw(reply, "ABC", ["web"])[0]!.url).toBe("");
    expect(rowsFromJiraRaw("", "ABC", ["web"])).toEqual([]);
  });

  test("priority names map to p0..p3, unknown ones stay unset", () => {
    expect([priorityFromJira("Highest"), priorityFromJira("high"), priorityFromJira("Medium"), priorityFromJira("Lowest")]).toEqual([0, 1, 2, 3]);
    expect(priorityFromJira("Whenever")).toBeUndefined();
    expect(priorityFromJira(undefined)).toBeUndefined();
  });

  test("the query narrows to the open sprint or in-progress work by default, and a filter replaces that", () => {
    expect(worklistJql("ABC")).toBe(`project = ABC AND assignee = currentUser() AND statusCategory != Done AND issuetype != Epic AND (${DEFAULT_WORKLIST_JQL})`);
    expect(worklistJql("ABC", "labels = x")).toEndWith("issuetype != Epic AND (labels = x)");
    expect(worklistJql("ABC", "  ")).toEndWith("issuetype != Epic");
  });

  test("jiraRows lists the tickets, reads their parents for epics, and reports a failure with the project", () => {
    const calls: string[][] = [];

    const runner = (cmd: string[]) => {
      calls.push(cmd);

      return { ok: true, stdout: cmd[2] === "list" ? reply : epic, stderr: "", code: 0 };
    };

    const rows = jiraRows("ABC", ["web"], { filter: "" }, runner, viewTicket(runner));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ epic: "ABC-1", epicTitle: "Dark mode" });
    expect(calls).toEqual([
      ["jira", "issue", "list", "--jql", worklistJql("ABC", ""), "--raw"],
      ["jira", "issue", "view", "ABC-1", "--raw"],
    ]);
    expect(() => jiraRows("ABC", ["web"], {}, () => ({ ok: false, stdout: "", stderr: "401 Unauthorized", code: 1 }))).toThrow(/jira: reading ABC failed: 401 Unauthorized/);
  });
});
