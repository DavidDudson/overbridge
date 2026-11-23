import { describe, expect, test } from "bun:test";
import { ItemStatus } from "../src/pm/provider";
import { clearProviders } from "../src/pm/registry";
import type { Runner } from "../src/pm/github";
import { jiraProvider } from "../src/pm/jira";
import { providerFor, registerBuiltins } from "../src/pm";
import { cachedTitle, refreshTitle } from "../src/pm/cache";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function stub(replies: Record<string, { ok?: boolean; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];

  const runner: Runner = (cmd) => {
    calls.push(cmd);
    const r = replies[`${cmd[1]} ${cmd[2]}`] ?? { ok: false, stderr: "unexpected call" };

    return { ok: r.ok ?? true, code: r.ok === false ? 1 : 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  return { runner, calls };
}

const cfg = { name: "jira", project: "ENG", url: "https://example.atlassian.net/" } as const;

describe("idFromBranch", () => {
  const p = jiraProvider(cfg, "/w");
  test.each([
    ["feat/ENG-123-thing", "ENG-123"],
    ["ENG-123", "ENG-123"],
    ["fix/eng-9-lowercase", "ENG-9"],
    ["feat/ENG-12", "ENG-12"],
  ])("%s -> %s", (branch, id) => expect(p.idFromBranch(branch)).toBe(id));

  test.each(["main", "feat/OPS-5-other-project", "feat/XENG-5", "feat/ENG-"])("%s -> none", (branch) => {
    expect(p.idFromBranch(branch)).toBeUndefined();
  });
});

describe("lineage", () => {
  const issue = (key: string, summary: string, status: string, parent?: string) =>
    JSON.stringify({ key, fields: { summary, status: { name: status }, parent: parent ? { key: parent } : null } });

  const viewer = (tickets: Record<string, string>) => {
    const calls: string[] = [];

    const runner: Runner = (cmd) => {
      calls.push(cmd[3]!);
      const out = tickets[cmd[3]!];

      return { ok: out !== undefined, code: out === undefined ? 1 : 0, stdout: out ?? "", stderr: out === undefined ? "not found" : "" };
    };

    return { runner, calls };
  };

  test("climbs from a subtask to its initiative, top first", () => {
    const v = viewer({
      "ENG-4": issue("ENG-4", "Subtask", "To Do", "ENG-3"),
      "ENG-3": issue("ENG-3", "Task", "Code Review", "ENG-2"),
      "ENG-2": issue("ENG-2", "Epic", "In Progress", "ENG-1"),
      "ENG-1": issue("ENG-1", "Initiative", "In Progress"),
    });

    const nodes = jiraProvider(cfg, "/w", v.runner).lineage("4");
    expect(nodes.map((n) => `${n.id} (${n.status}): ${n.title}`)).toEqual(["ENG-1 (In Progress): Initiative", "ENG-2 (In Progress): Epic", "ENG-3 (Code Review): Task", "ENG-4 (To Do): Subtask"]);
    expect(nodes[0]!.url).toBe("https://example.atlassian.net/browse/ENG-1");
  });

  test("stops at a parent it can't read, and at a loop", () => {
    expect(jiraProvider(cfg, "/w", viewer({ "ENG-3": issue("ENG-3", "Task", "Done", "ENG-2") }).runner).lineage("ENG-3").map((n) => n.id)).toEqual(["ENG-3"]);
    const loop = viewer({ "ENG-1": issue("ENG-1", "a", "", "ENG-2"), "ENG-2": issue("ENG-2", "b", "", "ENG-1") });
    expect(jiraProvider(cfg, "/w", loop.runner).lineage("ENG-1").map((n) => n.id)).toEqual(["ENG-2", "ENG-1"]);
    expect(jiraProvider(cfg, "/w", viewer({}).runner).lineage("ENG-9")).toEqual([]);
  });

  test("an unset site gives empty links", () => {
    const p = jiraProvider({ name: "jira", project: "ENG" }, "/w", viewer({ "ENG-1": issue("ENG-1", "a", "Open") }).runner);
    expect(p.lineage("1")).toEqual([{ id: "ENG-1", title: "a", status: "Open", url: "" }]);
  });
});

describe("links and names", () => {
  const p = jiraProvider(cfg, "/w");
  test("link trims the base and accepts a bare number", () => {
    expect(p.link("ENG-1")).toBe("https://example.atlassian.net/browse/ENG-1");
    expect(p.link("42")).toBe("https://example.atlassian.net/browse/ENG-42");
  });

  test("link explains the missing url", () => {
    expect(() => jiraProvider({ name: "jira", project: "ENG" }, "/w").link("1")).toThrow("project-management.url");
  });

  test("branchName follows the convention and round-trips", () => {
    const branch = p.branchName({ id: "42", title: "Fix the login bug" });
    expect(branch).toBe("feat/ENG-42-fix-the-login-bug");
    expect(p.idFromBranch(branch)).toBe("ENG-42");
  });

  test("workspaceName is the normalised ticket key", () => {
    expect(p.workspaceName("42", "app")).toBe("ENG-42");
    expect(p.workspaceName("eng-42", "app")).toBe("ENG-42");
  });
});

describe("jira-cli calls", () => {
  test("title reads the summary and normalises a bare number", () => {
    const { runner, calls } = stub({ "issue view": { stdout: JSON.stringify({ key: "ENG-7", fields: { summary: "Seven" } }) } });
    expect(jiraProvider(cfg, "/w", runner).title("7")).toBe("Seven");
    expect(calls[0]).toEqual(["jira", "issue", "view", "ENG-7", "--raw"]);
  });

  test("title is undefined on failure or bad JSON", () => {
    expect(jiraProvider(cfg, "/w", stub({ "issue view": { ok: false } }).runner).title("7")).toBeUndefined();
    expect(jiraProvider(cfg, "/w", stub({ "issue view": { stdout: "nope" } }).runner).title("7")).toBeUndefined();
  });

  test("status reads the status category", () => {
    const status = (reply: { ok?: boolean; stdout?: string }) => jiraProvider(cfg, "/w", stub({ "issue view": reply }).runner).status("7");
    const raw = (key: string) => ({ stdout: JSON.stringify({ fields: { status: { statusCategory: { key } } } }) });
    expect(status(raw("done"))).toBe(ItemStatus.Done);
    expect(status(raw("indeterminate"))).toBe(ItemStatus.Open);
    expect(status({ ok: false })).toBeUndefined();
    expect(status({ stdout: "{}" })).toBeUndefined();
  });

  test("assigned excludes done work and epics in the JQL", () => {
    const json = JSON.stringify([{ key: "ENG-1", fields: { summary: "One" } }]);
    const { runner, calls } = stub({ "issue list": { stdout: json } });
    expect(jiraProvider(cfg, "/w", runner).assigned()).toEqual([
      { id: "ENG-1", title: "One", url: "https://example.atlassian.net/browse/ENG-1" },
    ]);
    const jql = calls[0]![calls[0]!.indexOf("--jql") + 1]!;
    expect(jql).toBe("project = ENG AND assignee = currentUser() AND statusCategory != Done AND issuetype != Epic");
  });

  test("assigned works without a url (empty link)", () => {
    const { runner } = stub({ "issue list": { stdout: JSON.stringify([{ key: "ENG-2", fields: { summary: "Two" } }]) } });
    expect(jiraProvider({ name: "jira", project: "ENG" }, "/w", runner).assigned()[0]!.url).toBe("");
  });

  test("assigned surfaces jira-cli errors", () => {
    const { runner } = stub({ "issue list": { ok: false, stderr: "unauthorized" } });
    expect(() => jiraProvider(cfg, "/w", runner).assigned()).toThrow("unauthorized");
  });
});

describe("registration and cache", () => {
  test("is registered under 'jira'", () => {
    clearProviders();
    registerBuiltins();
    expect(providerFor(cfg, "/w").name).toBe("jira");
  });

  test("titles share the cache with other providers", () => {
    const tmp = mkdtempSync(join(tmpdir(), "overbridge-jira-"));
    const saved = process.env.OVERBRIDGE_ROOT;
    process.env.OVERBRIDGE_ROOT = tmp;

    try {
      const { runner } = stub({ "issue view": { stdout: JSON.stringify({ fields: { summary: "Cached" } }) } });
      const p = jiraProvider(cfg, "/w", runner);
      expect(refreshTitle(p, "ENG", "ENG-3")).toBe("Cached");
      expect(cachedTitle(p, "ENG", "ENG-3")).toBe("Cached");
    } finally {
      saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("rejects an invalid project key", () => {
    expect(() => jiraProvider({ name: "jira", project: "not a key" }, "/w")).toThrow("project key");
  });
});
