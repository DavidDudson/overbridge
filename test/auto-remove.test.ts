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
    const { unsaved } = createReaper(f.deps)([{ tab: "a" }, { tab: "b" }, { tab: "c" }]);
    expect(f.removed).toEqual(["a"]);
    expect([...unsaved]).toEqual(["b"]);
    expect(f.gitChecks).toEqual(["a", "b"]);
  });

  test("never touches an orchestration tab or a workspace whose removal failed", () => {
    const f = fake({ ended: ["@root", "a"] });
    const { unsaved } = createReaper(f.deps)([{ tab: "@root" }, { tab: "a", error: "pre-remove hook failed" }, { tab: "b", fault: "top cache: got null" }]);
    expect(f.removed).toEqual([]);
    expect(f.gitChecks).toEqual([]);
    expect(unsaved.size).toBe(0);
  });

  test("checks git once per recheck window, then removes once the work is pushed", () => {
    const f = fake({ ended: ["b"], dirty: ["b"] });
    const reap = createReaper(f.deps);
    reap([{ tab: "b" }]);
    f.dirty.delete("b");
    expect([...reap([{ tab: "b" }]).unsaved]).toEqual(["b"]);
    expect(f.gitChecks).toEqual(["b"]);
    f.clock.nowMs += GIT_RECHECK_MS;
    expect(reap([{ tab: "b" }]).unsaved.size).toBe(0);
    expect(f.removed).toEqual(["b"]);
  });
});

describe("one workspace's failure", () => {
  const boom = (bad: string, what: string) => (ws: string) => {
    if (ws === bad) throw new Error(`${what} for ${ws}`);
  };

  test("a git check that throws marks that workspace and the others are still reaped", () => {
    const f = fake({ ended: ["a", "b", "c"], dirty: ["c"] });
    const base = f.deps.gitClean;
    f.deps.gitClean = (ws) => {
      boom("a", "no workspace")(ws);
      return base(ws);
    };
    const { unsaved, faults } = createReaper(f.deps)([{ tab: "a" }, { tab: "b" }, { tab: "c" }]);
    expect(faults.get("a")).toBe("no workspace for a");
    expect(f.removed).toEqual(["b"]);
    expect([...unsaved]).toEqual(["c"]);
  });

  test("an ended check that throws marks that workspace only", () => {
    const f = fake({ ended: ["a", "b"] });
    const base = f.deps.endedForGood;
    f.deps.endedForGood = (ws) => {
      boom("b", "agent file")(ws);
      return base(ws);
    };
    const { faults } = createReaper(f.deps)([{ tab: "a" }, { tab: "b" }]);
    expect([...faults.keys()]).toEqual(["b"]);
    expect(f.removed).toEqual(["a"]);
  });

  test("a removal that throws (a locked state file) marks that workspace, and the others are removed", () => {
    const f = fake({ ended: ["a", "b"] });
    f.deps.remove = (ws) => {
      boom("a", "state is locked")(ws);
      f.removed.push(ws);
      return undefined;
    };
    const { faults } = createReaper(f.deps)([{ tab: "a" }, { tab: "b" }]);
    expect(faults.get("a")).toBe("state is locked for a");
    expect(f.removed).toEqual(["b"]);
  });

  test("a fault is held for the recheck window, then the workspace is tried again", () => {
    const f = fake({ ended: ["a"] });
    let fail = true;
    f.deps.remove = (ws) => {
      if (fail) throw new Error("state is locked");
      f.removed.push(ws);
      return undefined;
    };
    const reap = createReaper(f.deps);
    expect(reap([{ tab: "a" }]).faults.get("a")).toBe("state is locked");
    fail = false;
    expect(reap([{ tab: "a" }]).faults.get("a")).toBe("state is locked");
    expect(f.removed).toEqual([]);
    f.clock.nowMs += GIT_RECHECK_MS;
    expect(reap([{ tab: "a" }]).faults.size).toBe(0);
    expect(f.removed).toEqual(["a"]);
  });

  test("a fault is forgotten once the workspace leaves the list", () => {
    const f = fake({ ended: ["a"] });
    f.deps.remove = () => {
      throw new Error("gone");
    };
    const reap = createReaper(f.deps);
    reap([{ tab: "a" }]);
    expect(reap([]).faults.size).toBe(0);
    f.deps.remove = (ws) => {
      f.removed.push(ws);
      return undefined;
    };
    expect(reap([{ tab: "a" }]).faults.size).toBe(0);
    expect(f.removed).toEqual(["a"]);
  });
});
