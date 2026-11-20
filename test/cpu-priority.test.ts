import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classTarget, classTargets, DEFAULT_CLASSES, defaultNice } from "../src/check-priority";
import { BackgroundPolicy, backgroundPolicy, type PlanInput, planPriority, protectedPids, readPriorityReport, workspaceOf, writePriorityReport } from "../src/cpu-priority";
import { type ApplyDeps, applyPriority, formatReport } from "../src/cpu-priority-run";
import type { EnvProc } from "../src/proc";

const proc = (pid: number, ppid: number, extra: Partial<EnvProc> = {}): EnvProc => ({ pid, ppid, comm: "sh", state: "S", nice: 0, ...extra });

const NORMAL = classTarget(DEFAULT_CLASSES, "normal");
const LOW = classTarget(DEFAULT_CLASSES, "low");
const HIGH = classTarget(DEFAULT_CLASSES, "high");
const NICES = classTargets(DEFAULT_CLASSES).map((t) => t.nice);

/** launchd, a zellij server with a sidebar and a Claude pane for `ws`, and an app it started detached. */
const tree = (ws = "a"): EnvProc[] => [
  proc(1, 0, { comm: "launchd" }),
  proc(10, 1, { comm: "zellij" }),
  proc(11, 10, { comm: "bun" }), // sidebar pane
  proc(12, 10, { comm: "bun" }), // `overbridge claude a` launcher
  proc(13, 12, { comm: "claude", env: ws }),
  proc(14, 13, { comm: "zsh", env: ws }),
  proc(15, 14, { comm: "node", env: ws }),
  proc(20, 1, { comm: "node", env: ws }), // a detached app
];

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  procs: tree(),
  guarded: [],
  targets: { a: NORMAL },
  classNices: NICES,
  previous: {},
  policy: BackgroundPolicy.Darwin,
  now: 1_000,
  ...over,
});

describe("class targets", () => {
  test("classes without a nice spread by rank from 1, so the multiplexer's 0 stays above them all", () => {
    expect([0, 1, 2, 9].map(defaultNice)).toEqual([1, 5, 9, 19]);
    expect(classTargets(DEFAULT_CLASSES)).toEqual([
      { name: "high", nice: 1, background: false },
      { name: "normal", nice: 5, background: false },
      { name: "low", nice: 9, background: true },
    ]);
  });

  test("a class's own nice wins, and an unknown name gets the default class's target", () => {
    const classes = [{ name: "hot", icon: "a", nice: 2 }, { name: "cold", icon: "b", background: true }];
    expect(classTarget(classes, "hot")).toEqual({ name: "hot", nice: 2, background: false });
    expect(classTarget(classes, "gone")).toEqual({ name: "hot", nice: 2, background: false });
    expect(classTarget(classes, "cold")).toEqual({ name: "cold", nice: 5, background: true });
  });

  test("only macOS has Darwin background", () => {
    expect(backgroundPolicy("darwin")).toBe(BackgroundPolicy.Darwin);
    expect(backgroundPolicy("linux")).toBe(BackgroundPolicy.None);
  });
});

describe("protectedPids and workspaceOf", () => {
  test("the multiplexer, its ancestors and the guarded pids are protected", () => {
    expect([...protectedPids(tree(), [20])].toSorted((x, y) => x - y)).toEqual([1, 10, 20]);
  });

  test("a process belongs where OVERBRIDGE_NAME was set, and its descendants follow; panes without it belong nowhere", () => {
    const owners = workspaceOf(tree(), protectedPids(tree(), []));
    expect([...owners.keys()].toSorted((x, y) => x - y)).toEqual([13, 14, 15, 20]);
    expect(owners.get(15)).toBe("a");
  });

  test("a child that inherited nothing still follows its workspace ancestor", () => {
    const procs = [...tree(), proc(16, 15, { comm: "esbuild" })];
    expect(workspaceOf(procs, protectedPids(procs, [])).get(16)).toBe("a");
  });

  test("a value inherited from the multiplexer binds no pane: the climb stops at the protected server", () => {
    const procs = tree().map((p) => (p.pid === 10 || p.pid === 11 || p.pid === 12 ? { ...p, env: "z" } : p));
    const owners = workspaceOf(procs, protectedPids(procs, []));
    expect(owners.has(11)).toBe(false);
    expect(owners.has(12)).toBe(false);
    expect(owners.get(13)).toBe("a");
  });

  test("an empty value (an orchestration tab) belongs to no workspace, nor do its children", () => {
    const procs = [...tree(), proc(30, 10, { comm: "claude", env: "" }), proc(31, 30, { comm: "zsh", env: "" })];
    const owners = workspaceOf(procs, protectedPids(procs, []));
    expect(owners.has(30)).toBe(false);
    expect(owners.has(31)).toBe(false);
  });

  test("a nested workspace value starts that workspace's own subtree", () => {
    const procs = [...tree(), proc(40, 14, { comm: "bun", env: "b" })];
    expect(workspaceOf(procs, protectedPids(procs, [])).get(40)).toBe("b");
  });
});

describe("planPriority", () => {
  test("renices every member below its class's nice in one call per nice, and leaves the rest alone", () => {
    const procs = [...tree("a"), proc(50, 1, { comm: "node", env: "b" })];
    const plan = planPriority(input({ procs, targets: { a: NORMAL, b: LOW } }));
    expect(plan.renice).toEqual([
      { nice: 5, pids: [13, 14, 15, 20] },
      { nice: 9, pids: [50] },
    ]);
    expect(plan.report.workspaces.a).toEqual({ class: "normal", nice: 5, background: false, procs: 4, stuck: 0, backgroundPids: [] });
  });

  test("a workspace with no target (iceboxed, removed) is not touched", () => {
    expect(planPriority(input({ targets: {} })).renice).toEqual([]);
  });

  test("a class that rose cannot lower a nice: those processes count as stuck, a nice the user chose does not", () => {
    const procs = tree().map((p) => (p.pid === 13 ? { ...p, nice: 5 } : p.pid === 15 ? { ...p, nice: 17 } : p));
    const plan = planPriority(input({ procs, targets: { a: HIGH } }));
    expect(plan.renice).toEqual([{ nice: 1, pids: [14, 20] }]);
    expect(plan.report.workspaces.a?.stuck).toBe(1);
  });

  test("a background class moves only the members not already moved, and records them", () => {
    const plan = planPriority(input({ targets: { a: LOW }, previous: { a: { class: "low", nice: 9, background: true, procs: 2, stuck: 0, backgroundPids: [13, 14] } } }));
    expect(plan.toBackground).toEqual([15, 20]);
    expect(plan.report.workspaces.a?.backgroundPids).toEqual([13, 14, 15, 20]);
  });

  test("leaving a background class brings back the moved processes that are still its members", () => {
    const plan = planPriority(input({ previous: { a: { class: "low", nice: 9, background: true, procs: 2, stuck: 0, backgroundPids: [13, 99] } } }));
    expect(plan.toForeground).toEqual([13]);
    expect(plan.report.workspaces.a?.backgroundPids).toEqual([]);
  });

  test("off macOS nothing goes to background", () => {
    const plan = planPriority(input({ targets: { a: LOW }, policy: BackgroundPolicy.None }));
    expect(plan.toBackground).toEqual([]);
    expect(plan.report.workspaces.a?.background).toBe(false);
  });
});

describe("applyPriority", () => {
  const deps = (over: Partial<ApplyDeps> = {}) => {
    const ran: string[][] = [];
    const written: unknown[] = [];

    const d: ApplyDeps = {
      procs: () => tree(),
      classes: () => ({ a: "low" }),
      priorityClasses: () => DEFAULT_CLASSES,
      guarded: () => [],
      previous: () => ({ at: 0, workspaces: {} }),
      run: (cmd) => void ran.push(cmd),
      write: (r) => void written.push(r),
      policy: BackgroundPolicy.Darwin,
      now: () => 5,
      ...over,
    };

    return { d, ran, written };
  };

  test("runs renice, then taskpolicy per process, and writes the report", () => {
    const { d, ran, written } = deps();
    applyPriority(d);
    expect(ran).toEqual([
      ["renice", "9", "-p", "13", "14", "15", "20"],
      ...[13, 14, 15, 20].map((pid) => ["taskpolicy", "-b", "-p", String(pid)]),
    ]);
    expect(written).toHaveLength(1);
  });

  test("the guarded server keeps its nice even with a workspace's value", () => {
    const { d, ran } = deps({ classes: () => ({ a: "normal" }), guarded: () => [20] });
    applyPriority(d);
    expect(ran).toEqual([["renice", "5", "-p", "13", "14", "15"]]);
  });
});

describe("report file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cpu-priority-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("round-trips, and a missing or bad file reads as empty", () => {
    const file = join(dir, "r.json");
    expect(readPriorityReport(file)).toEqual({ at: 0, workspaces: {} });
    const report = { at: 3, workspaces: { a: { class: "low", nice: 9, background: true, procs: 1, stuck: 0, backgroundPids: [7] } } };
    writePriorityReport(report, file);
    expect(readPriorityReport(file)).toEqual(report);
    writeFileSync(file, "{ nope");
    expect(readPriorityReport(file)).toEqual({ at: 0, workspaces: {} });
    writeFileSync(file, JSON.stringify({ at: 1, workspaces: { a: { class: "x" }, b: report.workspaces.a } }));
    expect(Object.keys(readPriorityReport(file).workspaces)).toEqual(["b"]);
  });

  test("formatReport shows stuck processes with what to do", () => {
    const text = formatReport({ at: 1, workspaces: { a: { class: "high", nice: 1, background: false, procs: 4, stuck: 2, backgroundPids: [] } } });
    expect(text).toContain("2 (restart to raise)");
    expect(formatReport({ at: 0, workspaces: {} })).toContain("no pass has run yet");
  });
});
