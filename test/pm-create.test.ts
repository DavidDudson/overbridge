import { describe, expect, test } from "bun:test";
import { githubProvider, type Runner } from "../src/pm/github";
import { jiraProvider } from "../src/pm/jira";

type Rule = [match: string[], answer: { ok?: boolean; stdout?: string; stderr?: string }];

/** A stub CLI: the first rule whose words all appear in the command answers; every call is recorded. */
function stub(rules: Rule[]) {
  const calls: string[][] = [];
  const runner: Runner = (cmd) => {
    calls.push(cmd);
    const r = rules.find(([words]) => words.every((w) => cmd.includes(w)))?.[1] ?? { ok: false, stderr: "unexpected call" };
    return { ok: r.ok ?? true, code: r.ok === false ? 1 : 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { runner, calls };
}

const gh = { name: "github", project: "acme/app" } as const;
const jira = { name: "jira", project: "ENG", url: "https://example.atlassian.net/" } as const;

describe("github createItem / updateItemBody", () => {
  test("creates an issue with labels", () => {
    const { runner, calls } = stub([[["issue", "create"], { stdout: "https://github.com/acme/app/issues/55\n" }]]);
    const item = githubProvider(gh, "/w", runner).createItem({ title: "T", body: "B", labels: ["a", "b"] });
    expect(item).toEqual({ id: "55", title: "T", url: "https://github.com/acme/app/issues/55" });
    expect(calls).toEqual([
      ["gh", "issue", "create", "-R", "acme/app", "--title", "T", "--body", "B", "--label", "a", "--label", "b"],
    ]);
  });

  test("attaches the new issue to its parent as a sub-issue", () => {
    const { runner, calls } = stub([
      [["issue", "create"], { stdout: "https://github.com/acme/app/issues/55" }],
      [["repos/acme/app/issues/55"], { stdout: "9001" }],
      [["POST"], { stdout: "{}" }],
    ]);
    githubProvider(gh, "/w", runner).createItem({ title: "T", body: "B", parent: "#17" });
    expect(calls.at(-1)).toEqual([
      "gh", "api", "-X", "POST", "repos/acme/app/issues/17/sub_issues", "-F", "sub_issue_id=9001",
    ]);
  });

  test("a failed parent link names the created issue", () => {
    const { runner } = stub([
      [["issue", "create"], { stdout: "https://github.com/acme/app/issues/55" }],
      [["repos/acme/app/issues/55"], { stdout: "9001" }],
      [["POST"], { ok: false, stderr: "Not Found" }],
    ]);
    expect(() => githubProvider(gh, "/w", runner).createItem({ title: "T", body: "B", parent: "17" })).toThrow(
      "created https://github.com/acme/app/issues/55 but could not attach it to #17",
    );
  });

  test("a failed create throws with gh's message", () => {
    const { runner } = stub([[["issue", "create"], { ok: false, stderr: "HTTP 403" }]]);
    expect(() => githubProvider(gh, "/w", runner).createItem({ title: "T", body: "B" })).toThrow("HTTP 403");
  });

  test("updateItemBody edits the issue body", () => {
    const { runner, calls } = stub([[["issue", "edit"], {}]]);
    githubProvider(gh, "/w", runner).updateItemBody("#9", "new body");
    expect(calls).toEqual([["gh", "issue", "edit", "9", "-R", "acme/app", "--body", "new body"]]);
  });
});

describe("jira createItem / updateItemBody", () => {
  test("creates a task and reads the key from the printed URL", () => {
    const { runner, calls } = stub([
      [["issue", "create"], { stdout: "✓ Issue created\nhttps://example.atlassian.net/browse/ENG-77\n" }],
    ]);
    const item = jiraProvider(jira, "/w", runner).createItem({ title: "T", body: "B", labels: ["debt"], parent: "12" });
    expect(item).toEqual({ id: "ENG-77", title: "T", url: "https://example.atlassian.net/browse/ENG-77" });
    expect(calls[0]).toEqual([
      "jira", "issue", "create", "-p", "ENG", "-t", "Task", "-s", "T", "-b", "B", "--no-input", "-l", "debt", "-P", "ENG-12",
    ]);
  });

  test("fails when no key is printed or the create fails", () => {
    const noKey = stub([[["issue", "create"], { stdout: "done" }]]).runner;
    expect(() => jiraProvider(jira, "/w", noKey).createItem({ title: "T", body: "B" })).toThrow("printed no key");
    const failing = stub([[["issue", "create"], { ok: false, stderr: "401" }]]).runner;
    expect(() => jiraProvider(jira, "/w", failing).createItem({ title: "T", body: "B" })).toThrow("401");
  });

  test("updateItemBody edits the ticket", () => {
    const { runner, calls } = stub([[["issue", "edit"], {}]]);
    jiraProvider(jira, "/w", runner).updateItemBody("eng-5", "new");
    expect(calls).toEqual([["jira", "issue", "edit", "ENG-5", "-b", "new", "--no-input"]]);
  });
});
