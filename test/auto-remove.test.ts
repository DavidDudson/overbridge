import { describe, expect, test } from "bun:test";
import { createReaper, GIT_RECHECK_MS, type ReapDeps } from "../src/auto-remove";

/** Reaper deps over fixed answers, recording git checks and removals. */
function fake(opts: { ended: string[]; dirty?: string[] }) {
  const gitChecks: string[] = [];
  const removed: string[] = [];
  const clock = { nowMs: 1_000_000 };
  const dirty = new Set(opts.dirty ?? []);
  const deps: ReapDeps = {
    endedForGood: (ws) => opts.ended.includes(ws),
    gitClean: (ws) => {
      gitChecks.push(ws);
      return !dirty.has(ws);
    },
    remove: (ws) => {
      removed.push(ws);
      return undefined;
    },
    now: () => clock.nowMs,
  };
  return { deps, gitChecks, removed, clock, dirty };
}

describe("createReaper", () => {
  test("removes clean ended workspaces and reports dirty ones as unsaved", () => {
    const f = fake({ ended: ["a", "b"], dirty: ["b"] });
    const unsaved = createReaper(f.deps)([{ tab: "a" }, { tab: "b" }, { tab: "c" }]);
    expect(f.removed).toEqual(["a"]);
    expect([...unsaved]).toEqual(["b"]);
    expect(f.gitChecks).toEqual(["a", "b"]);
  });

  test("never touches an orchestration tab or a workspace whose removal failed", () => {
    const f = fake({ ended: ["@root", "a"] });
    const unsaved = createReaper(f.deps)([{ tab: "@root" }, { tab: "a", error: "pre-remove hook failed" }]);
    expect(f.removed).toEqual([]);
    expect(f.gitChecks).toEqual([]);
    expect(unsaved.size).toBe(0);
  });

  test("checks git once per recheck window, then removes once the work is pushed", () => {
    const f = fake({ ended: ["b"], dirty: ["b"] });
    const reap = createReaper(f.deps);
    reap([{ tab: "b" }]);
    f.dirty.delete("b");
    expect([...reap([{ tab: "b" }])]).toEqual(["b"]);
    expect(f.gitChecks).toEqual(["b"]);
    f.clock.nowMs += GIT_RECHECK_MS;
    expect(reap([{ tab: "b" }]).size).toBe(0);
    expect(f.removed).toEqual(["b"]);
  });
});
