import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKLIST_JQL, jiraRows, priorityFromJira, rowsFromJiraRaw, worklistJql } from "../src/pm/board-jira";

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
      updatedAt: "2026-01-02T00:00:00.000+1000",
    });
    expect(b).toMatchObject({ id: "ABC-3", status: "todo", labels: [], blockedBy: [] });
    expect(b!.parent).toBeUndefined();
    expect(b!.priority).toBeUndefined();
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

  test("jiraRows runs one jira-cli call and reports a failure with the project", () => {
    const calls: string[][] = [];
    const rows = jiraRows("ABC", ["web"], { filter: "" }, (cmd) => {
      calls.push(cmd);
      return { ok: true, stdout: reply, stderr: "", code: 0 };
    });
    expect(rows).toHaveLength(2);
    expect(calls).toEqual([["jira", "issue", "list", "--jql", worklistJql("ABC", ""), "--raw"]]);
    expect(() => jiraRows("ABC", ["web"], {}, () => ({ ok: false, stdout: "", stderr: "401 Unauthorized", code: 1 }))).toThrow(/jira: reading ABC failed: 401 Unauthorized/);
  });
});
