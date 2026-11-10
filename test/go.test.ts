import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { go, pickGo } from "../src/go";
import { focusClaude } from "../src/panes";
import { withState } from "../src/state";
import { sessionExec } from "../src/tab";
import type { RunResult } from "../src/util";

const ok = (stdout = ""): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
const failed = (stderr = ""): RunResult => ({ ok: false, code: 1, stdout: "", stderr });

describe("pickGo", () => {
  const tabs = ["@root", "a", "b"];
  test("a number picks by the sidebar's 1-based order", () => {
    expect(pickGo(tabs, "a", "1")).toEqual({ tab: "@root" });
    expect(pickGo(tabs, "a", "3")).toEqual({ tab: "b" });
  });
  test("a number past the end, or zero, names the count", () => {
    expect(pickGo(tabs, "a", "4")).toEqual({ error: "no tab 4: 3 tabs" });
    expect(pickGo(tabs, "a", "0")).toEqual({ error: "no tab 0: 3 tabs" });
    expect(pickGo(["a"], "a", "2")).toEqual({ error: "no tab 2: 1 tab" });
  });
  test("a name picks that tab; root reaches @root", () => {
    expect(pickGo(tabs, "a", "b")).toEqual({ tab: "b" });
    expect(pickGo(tabs, "a", "@root")).toEqual({ tab: "@root" });
    expect(pickGo(tabs, "a", "root")).toEqual({ tab: "@root" });
    expect(pickGo(tabs, "a", "zzz")).toEqual({ error: "no tab 'zzz'" });
  });
  test("next and prev step from the current tab, wrapping", () => {
    expect(pickGo(tabs, "a", "next")).toEqual({ tab: "b" });
    expect(pickGo(tabs, "b", "next")).toEqual({ tab: "@root" });
    expect(pickGo(tabs, "@root", "prev")).toEqual({ tab: "b" });
    expect(pickGo(tabs, "b", "prev")).toEqual({ tab: "a" });
  });
  test("next and prev need a current tab and another to go to", () => {
    expect(pickGo(tabs, undefined, "next")).toEqual({ error: "not on a tab" });
    expect(pickGo(tabs, "gone", "prev")).toEqual({ error: "not on a tab" });
    expect(pickGo(["a"], "a", "next")).toEqual({ error: "only one tab" });
  });
});

describe("sessionExec", () => {
  test("outside zellij, actions target the session by name", () => {
    const calls: string[][] = [];
    const exec = sessionExec(false, "s", (cmd) => (calls.push(cmd), ok()));
    exec(["zellij", "action", "query-tab-names"]);
    exec(["zellij", "list-sessions"]);
    expect(calls).toEqual([
      ["zellij", "--session", "s", "action", "query-tab-names"],
      ["zellij", "list-sessions"],
    ]);
  });
  test("inside zellij, calls pass through unchanged", () => {
    const calls: string[][] = [];
    const exec = sessionExec(true, "s", (cmd) => (calls.push(cmd), ok()));
    exec(["zellij", "action", "query-tab-names"]);
    expect(calls).toEqual([["zellij", "action", "query-tab-names"]]);
  });
});

/** A fake zellij with `tabs` open, `current` focused and `panes` listed; `goes` is whether go-to-tab-name succeeds. */
const fakeZellij = (tabs: string[], current: string | undefined, panes: object[] = [], goes = true) => {
  const calls: string[][] = [];
  const exec = (cmd: string[]): RunResult => {
    calls.push(cmd);
    const action = cmd[2];
    if (action === "query-tab-names") return ok(tabs.join("\n"));
    if (action === "current-tab-info") return current === undefined ? failed() : ok(`name: ${current}\nposition: 0`);
    if (action === "list-panes") return ok(JSON.stringify(panes));
    if (action === "go-to-tab-name") return goes ? ok() : failed("no such tab");
    return ok();
  };
  return { calls, exec, actions: () => calls.map((c) => c.slice(2).join(" ")) };
};

const claudePane = (tab: string, id: number) => ({ id, is_plugin: false, exited: false, tab_name: tab, title: `${tab} · claude` });

describe("focusClaude", () => {
  test("focuses the tab's claude pane", () => {
    const z = fakeZellij([], undefined, [claudePane("a", 4), claudePane("b", 7)]);
    expect(focusClaude("b", z.exec)).toBe(true);
    expect(z.actions()).toEqual(["list-panes --json", "focus-pane-id terminal_7"]);
  });
  test("false, and no focus call, when the tab has none or the list is unreadable", () => {
    const z = fakeZellij([], undefined, [claudePane("a", 4)]);
    expect(focusClaude("b", z.exec)).toBe(false);
    expect(z.actions()).toEqual(["list-panes --json"]);
    const broken = (cmd: string[]) => (cmd[2] === "list-panes" ? ok("{nope") : z.exec(cmd));
    expect(focusClaude("a", broken)).toBe(false);
  });
});

describe("go", () => {
  let tmp: string;
  const savedRoot = process.env.OVERBRIDGE_ROOT;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "overbridge-go-"));
    process.env.OVERBRIDGE_ROOT = tmp;
    withState((s) => {
      s.workspaces.a = { created: "now", repos: {} };
      s.workspaces.b = { created: "now", repos: {} };
    });
  });
  afterEach(() => {
    savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("switches tab and lands on its claude pane", () => {
    const z = fakeZellij(["@root", "@work", "b", "a"], "a", [claudePane("b", 9)]);
    expect(go("3", z.exec)).toBe("→ b");
    expect(z.actions()).toEqual(["query-tab-names", "current-tab-info", "go-to-tab-name b", "list-panes --json", "focus-pane-id terminal_9"]);
  });
  test("numbers follow the sidebar: orchestration tabs first, then workspaces in tab order", () => {
    const z = fakeZellij(["@root", "@work", "b", "a"], "a");
    expect(go("1", z.exec)).toBe("→ @root");
    expect(go("2", z.exec)).toBe("→ @work");
    expect(go("4", z.exec)).toBe("→ a");
    expect(go("next", z.exec)).toBe("→ @root");
    expect(go("prev", z.exec)).toBe("→ b");
  });
  test("the switch stands when the tab has no claude pane", () => {
    const z = fakeZellij(["@root", "@work", "a", "b"], "a");
    expect(go("b", z.exec)).toBe("→ b");
    expect(z.actions()).toEqual(["query-tab-names", "current-tab-info", "go-to-tab-name b", "list-panes --json"]);
  });
  test("a bad target or a failed switch is an error", () => {
    expect(() => go("9", fakeZellij(["@root", "@work", "a", "b"], "a").exec)).toThrow("no tab 9: 4 tabs");
    expect(() => go("next", fakeZellij(["@root", "@work", "a", "b"], undefined).exec)).toThrow("not on a tab");
    expect(() => go("b", fakeZellij(["@root", "@work", "a", "b"], "a", [], false).exec)).toThrow("could not switch to b: no such tab");
  });
});
