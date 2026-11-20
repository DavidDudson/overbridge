import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classTarget, classTargets, DEFAULT_CLASSES, defaultNice } from "../src/check-priority";
import { BackgroundPolicy, backgroundPolicy, type PlanInput, planPriority, protectedPids, readPriorityReport, readPriorityReportCached, settleReport, workspaceOf, writePriorityReport } from "../src/cpu-priority";
import { type ApplyDeps, applyPriority, formatReport, liveClassesFrom, withPassLock } from "../src/cpu-priority-run";
import type { WorkspaceState } from "../src/state";
import type { EnvProc } from "../src/proc";

const proc = (pid: number, ppid: number, extra: Partial<EnvProc> = {}): EnvProc => ({ pid, ppid, comm: "sh", state: "S", nice: 0, ...extra });

const NORMAL = classTarget(DEFAULT_CLASSES, "normal");
const LOW = classTarget(DEFAULT_CLASSES, "low");
const HIGH = classTarget(DEFAULT_CLASSES, "high");
const NICES = classTargets(DEFAULT_CLASSES).map((t) => t.nice);

/** A zellij server's panes and a workspace `ws`'s processes, as the comments on each line say. */
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

const ROOT = "/ws";

const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  procs: tree(),
  root: ROOT,
  extraProtected: [],
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
  test("the multiplexer, its ancestors and the extra protected pids are protected", () => {
    expect([...protectedPids(tree(), [20])].toSorted((x, y) => x - y)).toEqual([1, 10, 20]);
  });

  test("a process belongs where OVERBRIDGE_NAME was set, and its descendants follow; panes without it belong nowhere", () => {
    const owners = workspaceOf(tree(), protectedPids(tree(), []), ROOT);
    expect([...owners.keys()].toSorted((x, y) => x - y)).toEqual([13, 14, 15, 20]);
    expect(owners.get(15)).toBe("a");
  });

  test("a child that inherited nothing still follows its workspace ancestor", () => {
    const procs = [...tree(), proc(16, 15, { comm: "esbuild" })];
    expect(workspaceOf(procs, protectedPids(procs, []), ROOT).get(16)).toBe("a");
  });

  test("a value inherited from the multiplexer binds no pane: the climb stops at the protected server", () => {
    const procs = tree().map((p) => (p.pid === 10 || p.pid === 11 || p.pid === 12 ? { ...p, env: "z" } : p));
    const owners = workspaceOf(procs, protectedPids(procs, []), ROOT);
    expect(owners.has(11)).toBe(false);
    expect(owners.has(12)).toBe(false);
    expect(owners.get(13)).toBe("a");
  });

  test("an empty value (an orchestration tab) belongs to no workspace, nor do its children", () => {
    const procs = [...tree(), proc(30, 10, { comm: "claude", env: "" }), proc(31, 30, { comm: "zsh", env: "" })];
    const owners = workspaceOf(procs, protectedPids(procs, []), ROOT);
    expect(owners.has(30)).toBe(false);
    expect(owners.has(31)).toBe(false);
  });

  test("a process that set another root's OVERBRIDGE_ROOT belongs to no workspace here, even with a matching name", () => {
    const procs = [...tree(), proc(60, 1, { comm: "claude", env: "a", root: "/other" }), proc(61, 60, { comm: "zsh", env: "a", root: "/other" })];
    const owners = workspaceOf(procs, protectedPids(procs, []), ROOT);
    expect(owners.has(60)).toBe(false);
    expect(owners.has(61)).toBe(false);
    expect(owners.get(13)).toBe("a");
  });

  test("a nested workspace value starts that workspace's own subtree", () => {
    const procs = [...tree(), proc(40, 14, { comm: "bun", env: "b" })];
    expect(workspaceOf(procs, protectedPids(procs, []), ROOT).get(40)).toBe("b");
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

  test("a workspace whose class is no longer known brings its live background processes back out", () => {
    const previous = { a: { class: "low", nice: 9, background: true, procs: 2, stuck: 0, backgroundPids: [13, 14, 99] } };
    const plan = planPriority(input({ targets: {}, previous }));
    expect(plan.toForeground).toEqual([13, 14]);
    expect(plan.renice).toEqual([]);
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
      enabled: () => true,
      procs: () => tree(),
      root: ROOT,
      classes: () => ({ a: "low" }),
      priorityClasses: () => DEFAULT_CLASSES,
      extraProtected: () => [],
      threads: (pid) => [pid],
      previous: () => ({ at: 0, workspaces: {} }),
      run: (cmd) => {
        ran.push(cmd);

        return true;
      },
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

  test("the protected server keeps its nice even with a workspace's value", () => {
    const { d, ran } = deps({ classes: () => ({ a: "normal" }), extraProtected: () => [20] });
    applyPriority(d);
    expect(ran).toEqual([["renice", "5", "-p", "13", "14", "15"]]);
  });

  test("a renice reaches every thread of each process", () => {
    const { d, ran } = deps({ classes: () => ({ a: "normal" }), threads: (pid) => (pid === 13 ? [13, 130, 131] : [pid]) });
    applyPriority(d);
    expect(ran[0]).toEqual(["renice", "5", "-p", "13", "130", "131", "14", "15", "20"]);
  });

  test("a taskpolicy that fails is retried by the next pass", () => {
    const { d, written } = deps({ run: (cmd) => !(cmd[0] === "taskpolicy" && cmd[3] === "15") });
    applyPriority(d);
    expect(written).toEqual([expect.objectContaining({ workspaces: { a: expect.objectContaining({ backgroundPids: [13, 14, 20] }) } })]);
  });

  test("an unreadable process list changes nothing and keeps the last report", () => {
    const { d, ran, written } = deps({ procs: () => undefined });
    expect(applyPriority(d)).toBeUndefined();
    expect(ran).toEqual([]);
    expect(written).toEqual([]);
  });

  test("turned off, it brings back out of background only the recorded pids still in that workspace, and renices nothing", () => {
    const previous = { at: 1, workspaces: { a: { class: "low", nice: 9, background: true, procs: 2, stuck: 0, backgroundPids: [13, 14, 11, 99] } } };
    const { d, ran, written } = deps({ enabled: () => false, previous: () => previous });
    applyPriority(d);
    expect(ran).toEqual([13, 14].map((pid) => ["taskpolicy", "-B", "-p", String(pid)]));
    expect(written).toEqual([{ at: 5, workspaces: {} }]);
  });
});

describe("settleReport", () => {
  const entry = (backgroundPids: number[]) => ({ class: "low", nice: 9, background: true, procs: 2, stuck: 0, backgroundPids });

  test("a failed -b is not recorded as moved, and a failed -B keeps its pid for a retry", () => {
    const report = { at: 2, workspaces: { a: entry([13, 14]) } };
    const settled = settleReport(report, { a: entry([20]) }, new Set([14]), new Set([20]));
    expect(settled.workspaces.a?.backgroundPids).toEqual([13, 20]);
  });

  test("a workspace that left the report stays while a pid of it is still in background", () => {
    const settled = settleReport({ at: 2, workspaces: {} }, { a: entry([13, 14]), b: entry([30]) }, new Set(), new Set([14]));
    expect(settled.workspaces).toEqual({ a: entry([14]) });
  });
});

describe("liveClassesFrom", () => {
  test("keeps an active workspace with a known class; leaves out one with no class yet, an iceboxed one and one being removed", () => {
    const active: WorkspaceState = { created: "", repos: {} };

    const workspaces = {
      known: active,
      unknown: active,
      iced: { ...active, iceboxed: { since: "" } },
      leaving: { ...active, removing: { since: new Date().toISOString() } },
    };

    expect(liveClassesFrom(workspaces, (ws) => (ws === "unknown" ? undefined : "low"))).toEqual({ known: "low" });
  });
});

describe("withPassLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cpu-priority-lock-"));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("a second pass while one holds the lock is skipped, and the lock is freed after", () => {
    const lock = join(dir, "l");
    expect(withPassLock(() => withPassLock(() => "inner", lock) ?? "skipped", lock)).toBe("skipped");
    expect(withPassLock(() => "again", lock)).toBe("again");
  });

  test("a lock left by a pass that died is taken over", () => {
    const lock = join(dir, "l");
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 120_000);
    utimesSync(lock, old, old);
    expect(withPassLock(() => "ran", lock)).toBe("ran");
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
    expect(readPriorityReportCached(file)).toEqual({ at: 0, workspaces: {} });
    writeFileSync(file, JSON.stringify({ at: 1, workspaces: { a: { class: "x" }, b: report.workspaces.a } }));
    expect(Object.keys(readPriorityReport(file).workspaces)).toEqual(["b"]);
  });

  test("the cached reader is empty with no file and follows each rewrite", () => {
    const file = join(dir, "c.json");
    expect(readPriorityReportCached(file)).toEqual({ at: 0, workspaces: {} });
    writePriorityReport({ at: 1, workspaces: {} }, file);
    expect(readPriorityReportCached(file).at).toBe(1);
    writePriorityReport({ at: 2, workspaces: {} }, file);
    expect(readPriorityReportCached(file).at).toBe(2);
  });

  test("formatReport shows stuck processes with what to do", () => {
    const text = formatReport({ at: 1, workspaces: { a: { class: "high", nice: 1, background: false, procs: 4, stuck: 2, backgroundPids: [] } } });
    expect(text).toContain("2 (restart to raise)");
    expect(formatReport({ at: 0, workspaces: {} })).toContain("no pass has run yet");
  });
});
