import { describe, expect, test } from "bun:test";
import { ItemStatus } from "../src/pm/provider";
import { githubProvider, type Runner } from "../src/pm/github";
import { providerFor, registerBuiltins } from "../src/pm";
import { clearProviders } from "../src/pm/registry";

/** A `gh` stub answering from `replies` by the command's first two words; records every call. */
function stub(replies: Record<string, { ok?: boolean; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];

  const runner: Runner = (cmd) => {
    calls.push(cmd);
    const r = replies[`${cmd[1]} ${cmd[2]}`] ?? { ok: false, stderr: "unexpected call" };

    return { ok: r.ok ?? true, code: r.ok === false ? 1 : 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  return { runner, calls };
}

const repoCfg = { name: "github", project: "acme/app" } as const;

describe("idFromBranch", () => {
  const p = githubProvider(repoCfg, "/w");
  test.each([
    ["123-short-title", "123"],
    ["feat/123-thing", "123"],
    ["fix/#45", "45"],
    ["#7", "7"],
    ["feat/456", "456"],
  ])("%s -> %s", (branch, id) => expect(p.idFromBranch(branch)).toBe(id));

  test.each(["main", "feat/dark-mode", "release/v2-x", "feat/thing-123"])("%s -> none", (branch) => {
    expect(p.idFromBranch(branch)).toBeUndefined();
  });
});

describe("lineage", () => {
  test("is the issue alone, read through REST: its number, title, lowercased state and url", () => {
    const { runner, calls } = stub({ "api repos/acme/app/issues/12": { stdout: JSON.stringify({ title: "T", state: "open", html_url: "u" }) } });
    expect(githubProvider(repoCfg, "/w", runner).lineage("#12")).toEqual([{ id: "12", title: "T", status: "open", url: "u" }]);
    expect(calls[0]).toEqual(["gh", "api", "repos/acme/app/issues/12"]);
  });

  test("reads nothing for an id that is not a number", () => {
    const { runner, calls } = stub({});
    expect(githubProvider(repoCfg, "/w", runner).lineage("../pulls/3")).toEqual([]);
    expect(calls).toEqual([]);
  });

  test("falls back to the issue link with no url, and gives nothing on a failure or a bad reply", () => {
    const p = (reply: { ok?: boolean; stdout?: string }) => githubProvider(repoCfg, "/w", stub({ "api repos/acme/app/issues/12": reply }).runner);
    expect(p({ stdout: JSON.stringify({ title: "T", state: "closed" }) }).lineage("12")).toEqual([{ id: "12", title: "T", status: "closed", url: "https://github.com/acme/app/issues/12" }]);
    expect(p({ stdout: JSON.stringify({ title: "T", state: "OPEN", html_url: "u" }) }).lineage("12")[0]!.status).toBe("open");
    expect(p({ ok: false }).lineage("12")).toEqual([]);
    expect(p({ ok: false, stdout: JSON.stringify({ message: "Not Found" }) }).lineage("12")).toEqual([]);
    expect(p({ stdout: JSON.stringify({ title: "T", state: "open", pull_request: { url: "x" } }) }).lineage("12")).toEqual([]);
    expect(p({ stdout: "not json" }).lineage("12")).toEqual([]);
    expect(p({ stdout: "{}" }).lineage("12")).toEqual([]);
  });
});

describe("owner/repo project", () => {
  test("link and branchName need no network", () => {
    const { runner, calls } = stub({});
    const p = githubProvider(repoCfg, "/w", runner);
    expect(p.link("12")).toBe("https://github.com/acme/app/issues/12");
    expect(p.link("#12")).toBe("https://github.com/acme/app/issues/12");
    expect(p.branchName({ id: "12", title: "Add dark mode!" })).toBe("12-add-dark-mode");
    expect(calls).toEqual([]);
  });

  test("workspaceName is gh-<repo>-<number>", () => {
    const p = githubProvider(repoCfg, "/w", stub({}).runner);
    expect(p.workspaceName("12", "overbridge")).toBe("gh-overbridge-12");
    expect(p.workspaceName("#12", "overbridge")).toBe("gh-overbridge-12");
  });

  test("title asks gh for that issue", () => {
    const { runner, calls } = stub({ "issue view": { stdout: "Fix login" } });
    expect(githubProvider(repoCfg, "/w", runner).title("12")).toBe("Fix login");
    expect(calls[0]).toEqual(["gh", "issue", "view", "12", "-R", "acme/app", "--json", "title", "-q", ".title"]);
  });

  test("status reads a closed issue as done", () => {
    const status = (reply: { ok?: boolean; stdout?: string }) => githubProvider(repoCfg, "/w", stub({ "issue view": reply }).runner).status("#12");
    expect(status({ stdout: "CLOSED" })).toBe(ItemStatus.Done);
    expect(status({ stdout: "OPEN" })).toBe(ItemStatus.Open);
    expect(status({ ok: false })).toBeUndefined();
  });

  test("title is undefined when gh fails", () => {
    const { runner } = stub({ "issue view": { ok: false, stderr: "not found" } });
    expect(githubProvider(repoCfg, "/w", runner).title("12")).toBeUndefined();
  });

  test("assigned lists my open issues", () => {
    const json = JSON.stringify([{ number: 3, title: "Three", url: "https://github.com/acme/app/issues/3" }]);
    const { runner, calls } = stub({ "issue list": { stdout: json } });
    expect(githubProvider(repoCfg, "/w", runner).assigned()).toEqual([
      { id: "3", title: "Three", url: "https://github.com/acme/app/issues/3" },
    ]);
    expect(calls[0]).toContain("assignee:@me");
    expect(calls[0]).toContain("acme/app");
  });

  test("assigned surfaces gh errors", () => {
    const { runner } = stub({ "issue list": { ok: false, stderr: "auth required" } });
    expect(() => githubProvider(repoCfg, "/w", runner).assigned()).toThrow("auth required");
  });
});

describe("project number", () => {
  const cfg = { name: "github", project: "4" } as const;

  test("resolves the repo from cwd once and scopes the search to the project", () => {
    const { runner, calls } = stub({
      "repo view": { stdout: "acme/app" },
      "issue list": { stdout: "[]" },
    });

    const p = githubProvider(cfg, "/w", runner);
    p.assigned();
    p.link("1");
    expect(calls.filter((c) => c[2] === "view" && c[1] === "repo")).toHaveLength(1);
    const list = calls.find((c) => c[1] === "issue")!;
    expect(list[list.indexOf("--search") + 1]).toBe("assignee:@me project:acme/4");
  });

  test("explains when cwd is not a GitHub repo", () => {
    const { runner } = stub({ "repo view": { ok: false, stderr: "no git remotes" } });
    expect(() => githubProvider(cfg, "/w", runner).link("1")).toThrow("no git remotes");
  });
});

describe("validation", () => {
  test("rejects a project that is neither owner/repo nor a number", () => {
    expect(() => githubProvider({ name: "github", project: "just-a-name" }, "/w")).toThrow("owner/repo");
  });

  test("is registered under 'github'", () => {
    clearProviders();
    registerBuiltins();
    expect(providerFor(repoCfg, "/w").name).toBe("github");
  });
});
