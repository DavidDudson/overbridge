import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogPaths, issueOf } from "../src/stack";

describe("issueOf", () => {
  test.each([
    ["feat/383-iwr-rule-elements", 383],
    ["fix/7-typo", 7],
    ["docs/sheet-layout", undefined],
    ["release/2024-10", undefined],
    ["chore/2024-10-bump", undefined],
    ["Feat/12-x", undefined],
    ["pr-123", undefined],
    ["feat/383", undefined],
    ["main", undefined],
  ])("%s → %p", (branch, issue) => {
    expect(issueOf(branch)).toBe(issue);
  });
});

describe("catalogPaths", () => {
  test("every worktree's catalog, then the shared one", () => {
    const bare = mkdtempSync(join(tmpdir(), "overbridge-stack-"));
    mkdirSync(join(bare, "worktrees", "b"), { recursive: true });
    mkdirSync(join(bare, "worktrees", "a"), { recursive: true });
    expect(catalogPaths(bare)).toEqual([join(bare, "worktrees", "a", "gh-stack"), join(bare, "worktrees", "b", "gh-stack"), join(bare, "gh-stack")]);
    rmSync(bare, { recursive: true, force: true });
  });

  test("a bare repo with no worktrees has only the shared catalog", () => {
    expect(catalogPaths("/no/such/bare")).toEqual(["/no/such/bare/gh-stack"]);
  });
});
