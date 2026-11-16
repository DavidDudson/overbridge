import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { catalogPaths, cover, issueOf, readWorktreeCatalog, stacksIn } from "../src/stack";

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
  test("every live worktree's catalog, then the shared one; a worktree whose folder is gone is left out", () => {
    const bare = mkdtempSync(join(tmpdir(), "overbridge-stack-"));

    for (const [name, target] of [["b", bare], ["a", bare], ["gone", join(bare, "no-such-worktree", ".git")]] as const) {
      mkdirSync(join(bare, "worktrees", name), { recursive: true });
      writeFileSync(join(bare, "worktrees", name, "gitdir"), `${target}\n`);
    }

    // worktree.useRelativePaths: gitdir is relative to the admin dir
    const relAdmin = join(bare, "worktrees", "rel");
    mkdirSync(relAdmin, { recursive: true });
    const relTarget = join(bare, "rel-checkout-only-here");
    mkdirSync(relTarget);
    writeFileSync(join(relAdmin, "gitdir"), `${relative(relAdmin, relTarget)}\n`);
    // a gitdir that cannot be read keeps the worktree, so its stack still claims
    mkdirSync(join(bare, "worktrees", "no-gitdir"), { recursive: true });
    expect(catalogPaths(bare)).toEqual(["a", "b", "no-gitdir", "rel"].map((w) => join(bare, "worktrees", w, "gh-stack")).concat(join(bare, "gh-stack")));
    rmSync(bare, { recursive: true, force: true });
  });

  test("a bare repo with no worktrees has only the shared catalog", () => {
    expect(catalogPaths("/no/such/bare")).toEqual(["/no/such/bare/gh-stack"]);
  });

  test("a worktrees folder that cannot be listed throws instead of hiding every worktree catalog", () => {
    const bare = mkdtempSync(join(tmpdir(), "overbridge-stack-"));
    writeFileSync(join(bare, "worktrees"), "not a folder");
    expect(() => catalogPaths(bare)).toThrow();
    rmSync(bare, { recursive: true, force: true });
  });
});

describe("stacksIn", () => {
  const catalog = (...stacks: { branches: string[]; pr?: number }[]) =>
    JSON.stringify({ schemaVersion: 1, stacks: stacks.map((s) => ({ trunk: { branch: "main" }, branches: s.branches.map((b) => ({ branch: b, ...(s.pr && { pullRequest: { number: s.pr } }) })) })) });

  const withBare = (files: Record<string, string>, body: (bare: string) => void) => {
    const bare = mkdtempSync(join(tmpdir(), "overbridge-stacks-"));

    try {
      for (const [rel, text] of Object.entries(files)) {
        mkdirSync(join(bare, rel, ".."), { recursive: true });
        writeFileSync(join(bare, rel), text);

        // a worktree admin dir points at a live checkout
        if (rel.startsWith("worktrees/")) {
          writeFileSync(join(bare, rel, "..", "gitdir"), bare);
        }
      }

      body(bare);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  };

  test("a catalog only in a worktree's git dir is read", () => {
    withBare({ "worktrees/a/gh-stack": catalog({ branches: ["s1", "s2"] }) }, (bare) => {
      expect(stacksIn(bare).map((s) => s.layers.map((l) => l.branch))).toEqual([["s1", "s2"]]);
    });
  });

  test("a stack in a worktree catalog and the shared one appears once, from the worktree", () => {
    withBare({ "worktrees/a/gh-stack": catalog({ branches: ["s1", "s2"], pr: 7 }), "gh-stack": catalog({ branches: ["s1", "s2"], pr: 3 }, { branches: ["t1"] }) }, (bare) => {
      const stacks = stacksIn(bare);
      expect(stacks.map((s) => s.layers.map((l) => l.branch))).toEqual([["s1", "s2"], ["t1"]]);
      expect(stacks[0]!.layers[0]!.pr).toBe(7);
    });
  });

  test("an unreadable worktree catalog throws for claim checks and is skipped for display; a bad shared one always throws", () => {
    withBare({ "worktrees/a/gh-stack": "{nope", "worktrees/b/gh-stack": catalog({ branches: ["s1"] }) }, (bare) => {
      expect(() => stacksIn(bare)).toThrow();
      expect(stacksIn(bare, readWorktreeCatalog).map((s) => s.layers[0]!.branch)).toEqual(["s1"]);
    });
    withBare({ "gh-stack": "{nope" }, (bare) => {
      expect(() => stacksIn(bare)).toThrow();
      expect(() => stacksIn(bare, readWorktreeCatalog)).toThrow();
    });
  });
});

describe("cover", () => {
  const stack = (...branches: string[]) => ({ trunk: "main", layers: branches.map((branch) => ({ branch })) });

  test("a branch in two stacks covers the layers of both", () => {
    const stacks = [stack("p", "x"), stack("q", "y"), stack("p", "q")];
    expect([...cover(stacks, ["p"]).branches].toSorted()).toEqual(["p", "q", "x"]);
    expect([...cover(stacks, ["q"]).branches].toSorted()).toEqual(["p", "q", "y"]);
  });
});
