import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { newOrchestrationTabKdl } from "../src/layout";
import { ORCHESTRATION_TABS } from "../src/orchestration";
import { ensureOrchestrationTabs, QUICK_EXIT_MS, REOPEN_LOCK_STALE_MS, reopenLockPath, restartAfter } from "../src/orchestration-keep";

let tmp: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-keep-"));
  process.env.OVERBRIDGE_ROOT = tmp;
});

afterEach(() => {
  savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
  rmSync(tmp, { recursive: true, force: true });
});

/** A fake zellij: `tabs` is its tab list, which `new-tab` appends to and `move-tab left` reorders. */
function fakeZellij(initial: string[], focused = initial.at(-1) ?? "") {
  const tabs = [...initial];
  const calls: string[][] = [];
  const state = { focused };
  const exec = (cmd: string[]) => {
    calls.push(cmd);
    const [, , action, ...args] = cmd;
    if (action === "query-tab-names") {
      return { ok: true, stdout: tabs.join("\n") };
    }
    if (action === "current-tab-info") {
      return { ok: true, stdout: `name: ${state.focused}\nposition: 0` };
    }
    if (action === "new-tab") {
      tabs.push(args[args.indexOf("--name") + 1]!);
      state.focused = tabs.at(-1)!;
    }
    if (action === "move-tab") {
      const i = tabs.indexOf(state.focused);
      tabs.splice(i - 1, 0, ...tabs.splice(i, 1));
    }
    if (action === "go-to-tab-name") {
      state.focused = args[0]!;
    }
    return { ok: true, stdout: "" };
  };
  return { tabs, calls, state, exec };
}

const deps = (exec: ReturnType<typeof fakeZellij>["exec"]) => ({ exec, sleep: () => {}, kdl: () => "layout {}" });
const opened = (calls: string[][]) => calls.filter((c) => c[2] === "new-tab").length;

describe("ensureOrchestrationTabs", () => {
  test("a closed @root tab reopens at the front and focus returns to the tab the user was on", () => {
    const z = fakeZellij(["w1", "w2"], "w2");
    expect(ensureOrchestrationTabs(z.tabs, deps(z.exec))).toEqual(["@root"]);
    expect(z.tabs).toEqual(["@root", "w1", "w2"]);
    expect(z.state.focused).toBe("w2");
    expect(existsSync(reopenLockPath("@root"))).toBe(false);
  });

  test("does nothing when the tab is there, or outside zellij", () => {
    const z = fakeZellij(["@root", "w1"]);
    expect(ensureOrchestrationTabs(z.tabs, deps(z.exec))).toEqual([]);
    expect(ensureOrchestrationTabs([], deps(z.exec))).toEqual([]);
    expect(z.calls).toEqual([]);
  });

  test("two sidebars noticing at once open one copy: the second re-checks under the lock", () => {
    const z = fakeZellij(["w1"]);
    const stale = [...z.tabs];
    ensureOrchestrationTabs(stale, deps(z.exec));
    ensureOrchestrationTabs(stale, deps(z.exec));
    expect(opened(z.calls)).toBe(1);
    expect(z.tabs.filter((t) => t === "@root")).toHaveLength(1);
  });

  test("a live lock held by another sidebar means hands off", () => {
    const z = fakeZellij(["w1"]);
    mkdirSync(dirname(reopenLockPath("@root")), { recursive: true });
    writeFileSync(reopenLockPath("@root"), "");
    expect(ensureOrchestrationTabs(z.tabs, deps(z.exec))).toEqual([]);
    expect(z.calls).toEqual([]);
  });

  test("a stale lock from a dead sidebar is taken over", () => {
    const z = fakeZellij(["w1"]);
    mkdirSync(dirname(reopenLockPath("@root")), { recursive: true });
    writeFileSync(reopenLockPath("@root"), "");
    const old = (Date.now() - REOPEN_LOCK_STALE_MS - 1_000) / 1_000;
    utimesSync(reopenLockPath("@root"), old, old);
    expect(ensureOrchestrationTabs(z.tabs, deps(z.exec))).toEqual(["@root"]);
  });

  test("the reopen layout holds just the orchestration tab, focused", () => {
    const kdl = newOrchestrationTabKdl(ORCHESTRATION_TABS[0]!, ["overbridge"]);
    expect(kdl).toContain('tab name="@root" focus=true');
    expect(kdl).toContain('args "claude" "@root"');
    expect(kdl).not.toContain("--continue");
    expect(kdl).not.toContain("status-bar");
    expect(kdl.match(/tab name=/g)).toHaveLength(1);
  });
});

describe("restartAfter", () => {
  test("a session that ran a while restarts at once and resets the streak", () => {
    expect(restartAfter(QUICK_EXIT_MS * 10, 7)).toEqual({ streak: 0, delayMs: 0 });
  });

  test("quick exits restart at once, then back off doubling up to 30s", () => {
    expect(restartAfter(10, 0)).toEqual({ streak: 1, delayMs: 0 });
    expect(restartAfter(10, 1)).toEqual({ streak: 2, delayMs: 0 });
    expect(restartAfter(10, 2)).toEqual({ streak: 3, delayMs: 1_000 });
    expect(restartAfter(10, 3)).toEqual({ streak: 4, delayMs: 2_000 });
    expect(restartAfter(10, 20).delayMs).toBe(30_000);
  });
});
