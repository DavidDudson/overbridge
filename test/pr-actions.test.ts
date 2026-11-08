import { describe, expect, test } from "bun:test";
import { mergeFlag, mergePr, setReady } from "../src/pr-actions";
import type { RunResult } from "../src/util";

const ok = (stdout = ""): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
const bad = (stderr: string): RunResult => ({ ok: false, code: 1, stdout: "", stderr });
const recorder = (reply: (cmd: string[]) => RunResult) => {
  const calls: string[] = [];
  return { calls, exec: (cmd: string[], cwd: string) => (calls.push(`${cwd}: ${cmd.join(" ")}`), reply(cmd)) };
};

describe("setReady", () => {
  test("marks a lone PR ready, or back to draft with --undo", () => {
    const r = recorder(() => ok());
    expect(setReady({ dir: "/d", number: 7, stack: [] }, true, r.exec)).toBe("PR #7 ready for review");
    expect(setReady({ dir: "/d", number: 7, stack: [] }, false, r.exec)).toBe("PR #7 back to draft");
    expect(r.calls).toEqual(["/d: gh pr ready 7", "/d: gh pr ready --undo 7"]);
  });

  test("a stack flips every layer, stopping at the first error", () => {
    const r = recorder((cmd) => (cmd.includes("6") ? bad("boom\nmore") : ok()));
    expect(setReady({ dir: "/d", number: 7, stack: [5, 6, 7] }, true, r.exec)).toBe("PR #6: boom");
    expect(r.calls).toHaveLength(2);
    expect(setReady({ dir: "/d", number: 7, stack: [5, 7] }, true, recorder(() => ok()).exec)).toBe("2 PRs ready for review");
  });
});

describe("mergePr", () => {
  test("picks the first merge method the repo allows", () => {
    expect(mergeFlag({ squashMergeAllowed: true, mergeCommitAllowed: true })).toBe("--squash");
    expect(mergeFlag({ mergeCommitAllowed: true, rebaseMergeAllowed: true })).toBe("--merge");
    expect(mergeFlag({ rebaseMergeAllowed: true })).toBe("--rebase");
    expect(mergeFlag({})).toBeUndefined();
  });

  test("merges a lone PR with the allowed method and leaves its branch", () => {
    const r = recorder((cmd) => (cmd[1] === "repo" ? ok('{"squashMergeAllowed":true}') : ok()));
    expect(mergePr({ dir: "/d", number: 7, stack: [] }, r.exec)).toBe("merged PR #7");
    expect(r.calls.at(-1)).toBe("/d: gh pr merge 7 --squash");
  });

  test("reports gh's first error line, or an unreadable repo", () => {
    const r = recorder((cmd) => (cmd[1] === "repo" ? ok('{"mergeCommitAllowed":true}') : bad("not mergeable\nx")));
    expect(mergePr({ dir: "/d", number: 7, stack: [] }, r.exec)).toBe("PR #7: not mergeable");
    expect(mergePr({ dir: "/d", number: 7, stack: [] }, recorder(() => ok("nope")).exec)).toContain("could not tell");
  });

  test("a stack merges atomically through gh stack", () => {
    const r = recorder(() => ok());
    expect(mergePr({ dir: "/d", number: 7, stack: [6, 7] }, r.exec)).toBe("merged a stack of 2 PRs");
    expect(r.calls).toEqual(["/d: gh stack merge --yes"]);
  });
});
