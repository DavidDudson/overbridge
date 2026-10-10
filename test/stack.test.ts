import { describe, expect, test } from "bun:test";
import { issueOf } from "../src/stack";

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
