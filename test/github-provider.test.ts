import { describe, expect, test } from "bun:test";
import { createGithubProvider, idFromBranch, type GhRunner } from "../src/pm/github";
import type { RunResult } from "../src/util";

const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
const bad = (stderr: string): RunResult => ({ ok: false, code: 1, stdout: "", stderr });

/** A stubbed `gh`: answers by the first matching rule and records every call. */
function stub(rules: [match: (args: string[]) => boolean, answer: RunResult][] = []) {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push(args);
    return rules.find(([m]) => m(args))?.[1] ?? bad("unstubbed");
  };
  return { gh, calls };
}

const has = (...words: string[]) => (args: string[]) => words.every((w) => args.includes(w));
const config = { name: "github", project: "o/r" } as const;

describe("idFromBranch", () => {
  test("reads the issue number from the supported branch shapes", () => {
    expect(idFromBranch("123-short-title")).toBe("123");
    expect(idFromBranch("feat/123-thing")).toBe("123");
    expect(idFromBranch("#123")).toBe("123");
    expect(idFromBranch("fix/42")).toBe("42");
  });
  test("ignores branches without one", () => {
    expect(idFromBranch("main")).toBeUndefined();
    expect(idFromBranch("feat/v2-thing")).toBeUndefined();
    expect(idFromBranch("release-2024")).toBeUndefined();
  });
});

describe("github provider", () => {
  test("rejects a project that is neither owner/repo nor a number", () => {
    expect(() => createGithubProvider({ name: "github", project: "just-a-name" }, "/w", stub().gh)).toThrow(
      "expected owner/repo or a project number",
    );
  });

  test("link and branchName need no network", () => {
    const { gh, calls } = stub();
    const p = createGithubProvider(config, "/w", gh);
    expect(p.link("12")).toBe("https://github.com/o/r/issues/12");
    expect(p.link("#12")).toBe("https://github.com/o/r/issues/12");
    expect(p.branchName({ id: "12", title: "Add dark mode!" })).toBe("12-add-dark-mode");
    expect(calls).toEqual([]);
  });

  test("link honours a configured base url", () => {
    const p = createGithubProvider({ ...config, url: "https://ghe.example.com/" }, "/w", stub().gh);
    expect(p.link("1")).toBe("https://ghe.example.com/o/r/issues/1");
  });

  test("a project number resolves the repo from the worktree, once", () => {
    const { gh, calls } = stub([[has("repo", "view"), ok("acme/web")]]);
    const p = createGithubProvider({ name: "github", project: "4" }, "/w", gh);
    expect(p.link("1")).toBe("https://github.com/acme/web/issues/1");
    expect(p.link("2")).toBe("https://github.com/acme/web/issues/2");
    expect(calls).toHaveLength(1);
  });

  test("title returns the fetched title, or undefined on failure", () => {
    const { gh, calls } = stub([[has("issue", "view", "7"), ok("Fix login")]]);
    const p = createGithubProvider(config, "/w", gh);
    expect(p.title("7")).toBe("Fix login");
    expect(calls[0]).toEqual(["issue", "view", "7", "-R", "o/r", "--json", "title", "--jq", ".title"]);
    expect(p.title("8")).toBeUndefined();
  });

  test("assigned lists my open issues", () => {
    const json = JSON.stringify([{ number: 3, title: "Three", url: "https://github.com/o/r/issues/3" }]);
    const { gh, calls } = stub([[has("issue", "list"), ok(json)]]);
    const items = createGithubProvider(config, "/w", gh).assigned();
    expect(items).toEqual([{ id: "3", title: "Three", url: "https://github.com/o/r/issues/3" }]);
    expect(calls[0]).toContain("@me");
    expect(calls[0]).toContain("open");
  });

  test("assigned is empty when gh fails or answers nonsense", () => {
    expect(createGithubProvider(config, "/w", stub().gh).assigned()).toEqual([]);
    expect(createGithubProvider(config, "/w", stub([[has("issue", "list"), ok("not json")]]).gh).assigned()).toEqual([]);
  });
});

describe("github createItem / updateItemBody", () => {
  test("creates an issue with labels", () => {
    const { gh, calls } = stub([[has("issue", "create"), ok("https://github.com/o/r/issues/55")]]);
    const item = createGithubProvider(config, "/w", gh).createItem({ title: "T", body: "B", labels: ["a", "b"] });
    expect(item).toEqual({ id: "55", title: "T", url: "https://github.com/o/r/issues/55" });
    expect(calls).toEqual([["issue", "create", "-R", "o/r", "--title", "T", "--body", "B", "--label", "a", "--label", "b"]]);
  });

  test("attaches the new issue to its parent as a sub-issue", () => {
    const { gh, calls } = stub([
      [has("issue", "create"), ok("https://github.com/o/r/issues/55")],
      [has("api", "repos/o/r/issues/55"), ok("9001")],
      [has("api", "POST"), ok("{}")],
    ]);
    createGithubProvider(config, "/w", gh).createItem({ title: "T", body: "B", parent: "#17" });
    expect(calls.at(-1)).toEqual(["api", "-X", "POST", "repos/o/r/issues/17/sub_issues", "-F", "sub_issue_id=9001"]);
  });

  test("a failed parent link names the created issue", () => {
    const { gh } = stub([
      [has("issue", "create"), ok("https://github.com/o/r/issues/55")],
      [has("api", "repos/o/r/issues/55"), ok("9001")],
      [has("api", "POST"), bad("Not Found")],
    ]);
    expect(() => createGithubProvider(config, "/w", gh).createItem({ title: "T", body: "B", parent: "17" })).toThrow(
      "created https://github.com/o/r/issues/55 but could not attach it to #17",
    );
  });

  test("a failed create throws with gh's message", () => {
    const { gh } = stub([[has("issue", "create"), bad("HTTP 403")]]);
    expect(() => createGithubProvider(config, "/w", gh).createItem({ title: "T", body: "B" })).toThrow("HTTP 403");
  });

  test("updateItemBody edits the issue body", () => {
    const { gh, calls } = stub([[has("issue", "edit"), ok("")]]);
    createGithubProvider(config, "/w", gh).updateItemBody("#9", "new body");
    expect(calls).toEqual([["issue", "edit", "9", "-R", "o/r", "--body", "new body"]]);
  });
});
