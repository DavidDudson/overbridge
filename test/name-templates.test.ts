import { describe, expect, test } from "bun:test";
import { githubProvider, type Runner } from "../src/pm/github";
import { jiraProvider } from "../src/pm/jira";
import { branchType, renderTemplate } from "../src/pm/provider";
import { parseConfig, type ProjectManagement } from "../src/project-config";

/** A CLI stub answering from `replies` by the command's first two words; records every call. */
function stub(replies: Record<string, { ok?: boolean; stdout?: string }>) {
  const calls: string[][] = [];
  const runner: Runner = (cmd) => {
    calls.push(cmd);
    const r = replies[`${cmd[1]} ${cmd[2]}`] ?? { ok: false };
    return { ok: r.ok ?? true, code: r.ok === false ? 1 : 0, stdout: r.stdout ?? "", stderr: "" };
  };
  return { runner, calls };
}

const problems = (yaml: string) => {
  try {
    parseConfig(yaml, "f.yml");
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

const pm = (extra: string) => `project-management:\n  name: jira\n  project: ENG\n${extra}`;

describe("config", () => {
  test("reads the templates, branch types and issue type", () => {
    const config = parseConfig(
      pm("  branch: '{type}/{id}-{slug}'\n  workspace: '{id}'\n  branch-types: { Bug: fix, default: feat }\n  issue-type: Story\n"),
    );
    expect(config.projectManagement).toEqual({
      name: "jira",
      project: "ENG",
      branch: "{type}/{id}-{slug}",
      workspace: "{id}",
      branchTypes: { Bug: "fix", default: "feat" },
      issueType: "Story",
    });
  });

  test("reads worklist-jql, keeping an empty one so it can turn the default filter off", () => {
    expect(parseConfig(pm("  worklist-jql: sprint in openSprints()\n")).projectManagement?.worklistJql).toBe("sprint in openSprints()");
    expect(parseConfig(pm("  worklist-jql: ''\n")).projectManagement?.worklistJql).toBe("");
    expect(parseConfig(pm("")).projectManagement?.worklistJql).toBeUndefined();
    expect(problems(pm("  worklist-jql: [a]\n"))).toContain("worklist-jql");
  });

  test("rejects unknown placeholders and a template with no id", () => {
    expect(problems(pm("  branch: '{type}/{ticket}-{slug}'\n"))).toContain(
      "project-management.branch: unknown placeholder {ticket} (allowed: {id}, {number}, {slug}, {type})",
    );
    expect(problems(pm("  branch: 'feat/{slug}'\n"))).toContain("project-management.branch: needs {id} or {number}");
    expect(problems(pm("  workspace: '{slug}'\n"))).toContain("project-management.workspace: unknown placeholder {slug}");
    expect(problems(pm("  workspace: '{repo}'\n"))).toContain("project-management.workspace: needs {id} or {number}");
  });

  test("branch-types must map names to non-empty strings", () => {
    expect(problems(pm("  branch-types: [fix]\n"))).toContain("project-management.branch-types: expected a mapping");
    expect(problems(pm("  branch-types: { Bug: '' }\n"))).toContain("project-management.branch-types.Bug: expected a non-empty string");
  });
});

describe("helpers", () => {
  test("renderTemplate fills known placeholders and leaves others", () => {
    expect(renderTemplate("{type}/{id}-{slug}", { type: "fix", id: "ENG-1", slug: "x" })).toBe("fix/ENG-1-x");
    expect(renderTemplate("{id}-{other}", { id: "1" })).toBe("1-{other}");
  });

  test("branchType takes the first mapped type, ignoring case, then default, then feat", () => {
    expect(branchType(["Bug"], { Bug: "fix" })).toBe("fix");
    expect(branchType(["needs-review", "bug"], { Bug: "fix" })).toBe("fix");
    expect(branchType(["Story"], { Bug: "fix", default: "chore" })).toBe("chore");
    expect(branchType([], undefined)).toBe("feat");
  });
});

describe("jira", () => {
  const base: ProjectManagement = { name: "jira", project: "ENG" };
  const issue = (type: string) => ({ "issue view": { stdout: JSON.stringify({ fields: { summary: "S", issuetype: { name: type } } }) } });

  test("a branch template without {type} needs no network", () => {
    const { runner, calls } = stub({});
    const p = jiraProvider({ ...base, branch: "feature/{id}-{slug}" }, "/w", runner);
    const branch = p.branchName({ id: "42", title: "Fix the login bug" });
    expect(branch).toBe("feature/ENG-42-fix-the-login-bug");
    expect(p.idFromBranch(branch)).toBe("ENG-42");
    expect(calls).toEqual([]);
  });

  test("{type} comes from the issue type through branch-types", () => {
    const config = { ...base, branch: "{type}/{id}-{slug}", branchTypes: { Bug: "fix", default: "feat" } };
    expect(jiraProvider(config, "/w", stub(issue("Bug")).runner).branchName({ id: "42", title: "Crash" })).toBe("fix/ENG-42-crash");
    expect(jiraProvider(config, "/w", stub(issue("Story")).runner).branchName({ id: "42", title: "New" })).toBe("feat/ENG-42-new");
    expect(jiraProvider(config, "/w", stub({}).runner).branchName({ id: "42", title: "Unreadable" })).toBe("feat/ENG-42-unreadable");
  });

  test("itemTypes is the issue type", () => {
    expect(jiraProvider(base, "/w", stub(issue("Bug")).runner).itemTypes("ENG-1")).toEqual(["Bug"]);
    expect(jiraProvider(base, "/w", stub({ "issue view": { stdout: "{}" } }).runner).itemTypes("ENG-1")).toEqual([]);
    expect(jiraProvider(base, "/w", stub({ "issue view": { stdout: "not json" } }).runner).itemTypes("ENG-1")).toEqual([]);
  });

  test("a workspace template can use the repo and the number", () => {
    const p = jiraProvider({ ...base, workspace: "{repo}-{number}" }, "/w");
    expect(p.workspaceName("eng-42", "app")).toBe("app-42");
  });

  test("new items use issue-type, else Task", () => {
    const created = { "issue create": { stdout: "https://x/browse/ENG-9\n" } };
    const story = stub(created);
    jiraProvider({ ...base, issueType: "Story" }, "/w", story.runner).createItem({ title: "T", body: "B" });
    expect(story.calls[0]).toContain("Story");
    const task = stub(created);
    jiraProvider(base, "/w", task.runner).createItem({ title: "T", body: "B" });
    expect(task.calls[0]).toContain("Task");
  });
});

describe("github", () => {
  const base: ProjectManagement = { name: "github", project: "acme/app" };

  test("{type} comes from the issue's labels", () => {
    const { runner, calls } = stub({ "issue view": { stdout: "good first issue\nbug\n" } });
    const p = githubProvider({ ...base, branch: "{type}/{number}-{slug}", branchTypes: { bug: "fix" } }, "/w", runner);
    const branch = p.branchName({ id: "#12", title: "Crash on start" });
    expect(branch).toBe("fix/12-crash-on-start");
    expect(p.idFromBranch(branch)).toBe("12");
    expect(calls[0]).toEqual(["gh", "issue", "view", "12", "-R", "acme/app", "--json", "labels", "-q", ".labels[].name"]);
  });

  test("itemTypes is empty when gh fails", () => {
    expect(githubProvider(base, "/w", stub({}).runner).itemTypes("12")).toEqual([]);
  });

  test("a template idFromBranch could not read back is refused", () => {
    expect(() => githubProvider({ ...base, branch: "feat/gh{number}-{slug}" }, "/w")).toThrow("for github, {number} must start the name");
    expect(() => githubProvider({ ...base, branch: "{type}/#{id}" }, "/w")).not.toThrow();
  });

  test("a workspace template replaces gh-<repo>-<number>", () => {
    expect(githubProvider({ ...base, workspace: "issue-{number}" }, "/w").workspaceName("#12", "app")).toBe("issue-12");
    expect(githubProvider(base, "/w").workspaceName("#12", "app")).toBe("gh-app-12");
  });
});
