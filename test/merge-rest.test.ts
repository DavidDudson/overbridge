import { describe, expect, test } from "bun:test";
import { mergedHead, restMergedHeads, restPrCommand } from "../src/merge-rest";

const reply = (mergedAt: string | null, head = "abc") => JSON.stringify({ merged_at: mergedAt, head });
const MERGED_AT = "2026-11-01T00:00:00Z";

/** An exec that answers each PR number from `replies` and records what it was asked. */
function fakeExec(replies: Record<number, string | undefined>) {
  const calls: { cmd: string[]; cwd: string }[] = [];

  const exec = (cmd: string[], cwd: string) => {
    calls.push({ cmd, cwd });

    return replies[Number(cmd[2]!.split("/").at(-1))];
  };

  return { exec, calls };
}

describe("restPrCommand", () => {
  test("reads the PR through REST with the repo taken from the worktree", () => {
    expect(restPrCommand(7)).toEqual(["gh", "api", "repos/{owner}/{repo}/pulls/7", "--jq", "{merged_at, head: .head.sha}"]);
  });
});

describe("mergedHead", () => {
  test("gives the head of a merged PR", () => {
    expect(mergedHead(reply(MERGED_AT))).toBe("abc");
  });

  test("an unmerged PR has none", () => {
    expect(mergedHead(reply(null))).toBeUndefined();
  });

  test.each([undefined, "", "not json", "[1]", JSON.stringify({ merged_at: MERGED_AT })])("%p has none", (out) => {
    expect(mergedHead(out)).toBeUndefined();
  });
});

describe("restMergedHeads", () => {
  const dirOf = (repo: string) => `/ws/${repo}`;

  test("gives each repo's head once every claimed PR merged, reading in that repo's worktree", () => {
    const { exec, calls } = fakeExec({ 1: reply(MERGED_AT, "h1"), 2: reply(MERGED_AT, "h2") });
    expect(restMergedHeads({ a: { branch: "x", pr: 1 }, b: { branch: "y", pr: 2 } }, dirOf, exec)).toEqual({ a: "h1", b: "h2" });
    expect(calls.map((c) => c.cwd)).toEqual(["/ws/a", "/ws/b"]);
  });

  test("ignores released repos, which hold no branch", () => {
    const { exec, calls } = fakeExec({ 1: reply(MERGED_AT, "h1") });
    expect(restMergedHeads({ a: { branch: "x", pr: 1 }, b: {} }, dirOf, exec)).toEqual({ a: "h1" });
    expect(calls).toHaveLength(1);
  });

  test("a PR that has not merged leaves it unset", () => {
    const { exec } = fakeExec({ 1: reply(MERGED_AT), 2: reply(null) });
    expect(restMergedHeads({ a: { branch: "x", pr: 1 }, b: { branch: "y", pr: 2 } }, dirOf, exec)).toBeUndefined();
  });

  test("a failed read leaves it unset", () => {
    const { exec } = fakeExec({ 1: reply(MERGED_AT), 2: undefined });
    expect(restMergedHeads({ a: { branch: "x", pr: 1 }, b: { branch: "y", pr: 2 } }, dirOf, exec)).toBeUndefined();
  });

  test("a claim with no PR, or no claim at all, leaves it unset without a read", () => {
    const { exec, calls } = fakeExec({});
    expect(restMergedHeads({ a: { branch: "x" } }, dirOf, exec)).toBeUndefined();
    expect(restMergedHeads({}, dirOf, exec)).toBeUndefined();
    expect(calls).toEqual([]);
  });
});
