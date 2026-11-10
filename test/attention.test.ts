import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStateFile, readAgentState } from "../src/agent-state";
import { clearCompact, COMPACT_MARKER_MS, markCompact, nextState, recordState, takeCompactRestart } from "../src/agent-hook";
import { limitColor, limitRows, readLimits, timeLeft, WEEK_SECS } from "../src/limits";
import { pickNext } from "../src/next";
import { findPane, togglePane, type ZellijPane } from "../src/panes";
import { fit, textWidth } from "../src/term";
import { withState } from "../src/state";

describe("pickNext", () => {
  const list = [
    { tab: "a", state: "done" as const },
    { tab: "b", state: "waiting" as const },
    { tab: "c", state: "bg" as const },
    { tab: "d", state: "waiting" as const },
    { tab: "e", state: "busy" as const },
  ];
  test("waiting beats done beats background, cycling from the current tab", () => {
    expect(pickNext(list, "a")).toBe("b");
    expect(pickNext(list, "b")).toBe("d");
    expect(pickNext(list, "d")).toBe("b");
  });
  test("with no waiting tab, finished comes next, then background", () => {
    expect(pickNext(list.filter((e) => e.state !== "waiting"), "e")).toBe("a");
    expect(pickNext(list.filter((e) => e.state === "bg" || e.state === "busy"), "e")).toBe("c");
  });
  test("an orchestration tab is picked like any workspace", () => {
    expect(pickNext([{ tab: "@root", state: "waiting" }, { tab: "a", state: "done" }], "a")).toBe("@root");
  });
  test("never picks the current tab, and nothing waiting is undefined", () => {
    expect(pickNext([{ tab: "a", state: "waiting" }], "a")).toBeUndefined();
    expect(pickNext([{ tab: "a", state: "busy" }, { tab: "b" }], undefined)).toBeUndefined();
  });
});

describe("term width", () => {
  test("emoji take two columns", () => {
    expect(textWidth("🟢 ab")).toBe(5);
    expect(textWidth("✅")).toBe(2);
    expect(fit("🟢🟢🟢", 5)).toBe("🟢🟢…");
    expect(textWidth(fit("🟢🟢🟢", 5))).toBe(5);
  });
});

describe("limits", () => {
  const now = Date.UTC(2026, 10, 8) ;
  const secs = now / 1000;
  test("colour by projected usage at reset", () => {
    // half way through the week
    const reset = secs + WEEK_SECS / 2;
    expect(limitColor({ pct: 30, resetsAt: reset }, WEEK_SECS, secs)).toBe("green");
    expect(limitColor({ pct: 45, resetsAt: reset }, WEEK_SECS, secs)).toBe("yellow");
    expect(limitColor({ pct: 55, resetsAt: reset }, WEEK_SECS, secs)).toBe("red");
    expect(limitColor({ pct: 91, resetsAt: secs + WEEK_SECS }, WEEK_SECS, secs)).toBe("red");
  });
  test("time left", () => {
    expect(timeLeft(2 * 3600 + 10 * 60)).toBe("2h10m");
    expect(timeLeft(3 * 86400 + 4 * 3600)).toBe("3d4h");
  });
  test("rows show both limits, and a dash when unknown or stale", () => {
    const l = { at: now, fiveHour: { pct: 42, resetsAt: secs + 7800 }, weekly: { pct: 12, resetsAt: secs + 3 * 86400 } };
    const rows = limitRows(l, 30, now);
    expect(rows[0]).toContain("⏳ Hourly 42% 2h10m");
    expect(rows[1]).toContain("📅 Weekly 12% 3d0h");
    expect(limitRows(undefined, 30, now).join("")).toContain("–");
    expect(limitRows({ ...l, at: now - 7 * 3600_000 }, 30, now).join("")).not.toContain("42%");
  });
});

describe("agent state with background tasks", () => {
  let tmp: string;
  const saved = process.env.OVERBRIDGE_ROOT;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-bg-")));
    process.env.OVERBRIDGE_ROOT = tmp;
    mkdirSync(join(tmp, ".overbridge"), { recursive: true });
  });
  afterEach(() => {
    saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
    rmSync(tmp, { recursive: true, force: true });
  });
  test("done reads as bg while a recorded background shell lives", () => {
    recordState(join(tmp, ".overbridge"), "w1", "done", Date.now(), [4242]);
    expect(readAgentState("w1", Date.now(), () => true)).toBe("bg");
    expect(readAgentState("w1", Date.now(), () => false)).toBe("done");
  });
  test("done without background shells stays done", () => {
    recordState(join(tmp, ".overbridge"), "w1", "done");
    expect(readAgentState("w1", Date.now(), () => true)).toBe("done");
    writeFileSync(agentStateFile("w1"), JSON.stringify({ state: "busy", at: Date.now(), bg: [1] }));
    expect(readAgentState("w1", Date.now(), () => true)).toBe("busy");
  });
});

describe("pane toggles", () => {
  let tmp: string;
  const saved = process.env.OVERBRIDGE_ROOT;
  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-panes-")));
    process.env.OVERBRIDGE_ROOT = tmp;
    withState((s) => {
      s.workspaces.w1 = { created: "now", repos: { r: { branch: "b" }, q: { branch: "c" } } };
    });
  });
  afterEach(() => {
    saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
    rmSync(tmp, { recursive: true, force: true });
  });

  const pane = (id: number, kind: string, extra: Partial<ZellijPane> = {}): ZellijPane => ({ id, title: `w1 · ${kind}`, tab_name: "w1", ...extra });
  const fake = (panes: ZellijPane[]) => {
    const calls: string[][] = [];
    return {
      calls,
      deps: {
        self: ["ob"],
        zellij: (args: string[]) => {
          calls.push(args);
          return args[0] === "list-panes" ? JSON.stringify(panes) : "terminal_9";
        },
      },
    };
  };

  test("findPane matches tab and title, and skips exited or plugin panes", () => {
    const panes = [pane(1, "claude"), pane(2, "terminal", { exited: true }), pane(3, "terminal", { tab_name: "w2" }), pane(4, "diff", { is_plugin: true })];
    expect(findPane(panes, "w1", "claude")?.id).toBe(1);
    expect(findPane(panes, "w1", "terminal")).toBeUndefined();
    expect(findPane(panes, "w1", "diff")).toBeUndefined();
  });

  test("terminal opens right of claude in the first repo, and closes on a second press", () => {
    const opening = fake([pane(1, "claude")]);
    expect(togglePane("w1", "terminal", opening.deps)).toBeUndefined();
    expect(opening.calls[1]).toEqual(["focus-pane-id", "terminal_1"]);
    expect(opening.calls[2]!.slice(0, 5)).toEqual(["new-pane", "--direction", "right", "--name", "w1 · terminal"]);
    expect(opening.calls[2]).toContain(join(tmp, "w1", "r"));
    expect(opening.calls[2]).not.toContain("--");

    const closing = fake([pane(1, "claude"), pane(5, "terminal")]);
    togglePane("w1", "terminal", closing.deps);
    expect(closing.calls.map((c) => c[0])).toEqual(["list-panes", "close-pane", "focus-pane-id"]);
    expect(closing.calls[1]).toEqual(["close-pane", "--pane-id", "terminal_5"]);
  });

  test("a terminal in a repo with a dev shell runs the user's shell through overbridge shell", () => {
    mkdirSync(join(tmp, "w1", "r"), { recursive: true });
    writeFileSync(join(tmp, "w1", "r", "overbridge.yml"), "shell: wrap\n");
    const f = fake([pane(1, "claude")]);
    togglePane("w1", "terminal", f.deps);
    const open = f.calls[2]!;
    expect(open).toContain(join(tmp, "w1", "r"));
    expect(open.slice(open.indexOf("--") + 1, -1)).toEqual(["ob", "shell", "r", "--ws", "w1", "--"]);
    expect(open.at(-1)).toBe(process.env.SHELL || "sh");
  });

  test("diff stacks below an open terminal and runs the diff command", () => {
    const f = fake([pane(1, "claude"), pane(5, "terminal")]);
    togglePane("w1", "diff", f.deps);
    expect(f.calls[1]).toEqual(["focus-pane-id", "terminal_5"]);
    const open = f.calls[2]!;
    expect(open.slice(0, 3)).toEqual(["new-pane", "--direction", "down"]);
    expect(open.slice(open.indexOf("--") + 1)).toEqual(["ob", "diff", "--ws", "w1"]);
  });

  test("claude focuses its pane, or says it is missing", () => {
    const f = fake([pane(1, "claude")]);
    togglePane("w1", "claude", f.deps);
    expect(f.calls[1]).toEqual(["focus-pane-id", "terminal_1"]);
    expect(togglePane("w1", "claude", fake([]).deps)).toBe("no claude pane in this tab");
  });
});

describe("nextState", () => {
  test("a started or cleared session is empty; resume and compact are idle", () => {
    expect(nextState("SessionStart", "clear", undefined)).toBe("empty");
    expect(nextState("SessionStart", "startup", "done")).toBe("empty");
    expect(nextState("SessionStart", "resume", undefined)).toBe("idle");
    expect(nextState("SessionStart", "compact", undefined)).toBe("idle");
  });
  test("the idle notification does not turn empty into waiting", () => {
    expect(nextState("Notification", undefined, "empty")).toBeUndefined();
    expect(nextState("Notification", undefined, "busy")).toBe("waiting");
    expect(nextState("UserPromptSubmit", undefined, "empty")).toBe("busy");
  });
});

describe("auto-compact restart", () => {
  let meta: string;
  beforeEach(() => {
    meta = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-compact-")));
  });
  afterEach(() => rmSync(meta, { recursive: true, force: true }));

  test("a stop right after an auto-compact is restarted, once", () => {
    markCompact(meta, "w1", 1_000);
    expect(takeCompactRestart(meta, "w1", 2_000)).toBe(true);
    expect(takeCompactRestart(meta, "w1", 2_000)).toBe(false);
  });
  test("no marker, a cleared marker or a stale one means a normal stop", () => {
    expect(takeCompactRestart(meta, "w1")).toBe(false);
    markCompact(meta, "w1", 1_000);
    clearCompact(meta, "w1");
    expect(takeCompactRestart(meta, "w1", 2_000)).toBe(false);
    markCompact(meta, "w1", 1_000);
    expect(takeCompactRestart(meta, "w1", 1_000 + COMPACT_MARKER_MS)).toBe(false);
  });
  test("markers are per workspace", () => {
    markCompact(meta, "w1", 1_000);
    expect(takeCompactRestart(meta, "w2", 1_500)).toBe(false);
    expect(takeCompactRestart(meta, "w1", 1_500)).toBe(true);
  });
});
