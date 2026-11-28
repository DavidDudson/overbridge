import { beforeEach, describe, expect, test } from "bun:test";
import { afterAgentExit, launchArgs, withoutContinue } from "../src/agent-restart";
import { ensureAgentPane, placement, REOPEN_COOLDOWN_MS, resetAgentKeep } from "../src/agent-keep";
import type { MuxPane, NewPane } from "../src/mux";
import { QUICK_EXIT_MS } from "../src/orchestration-keep";
import { shouldKeepAgent } from "../src/sidebar";
import { deltaCommand, difftCommand, DIFFT_SIDE_BY_SIDE_MIN_COLUMNS, pickDiffTool } from "../src/panes";

const pane = (id: string, title: string, over: Partial<MuxPane> = {}): MuxPane => ({ id, title, tab: "w1", exited: false, ...over });

function fakeMux(panes: MuxPane[], opens = true) {
  const opened: NewPane[] = [];
  const closed: string[] = [];

  const mux = {
    listPanes: () => panes,
    newPane: (r: NewPane) => {
      opened.push(r);

      return opens;
    },
    closePane: (id: string) => {
      closed.push(id);

      return true;
    },
  };

  return { mux, opened, closed };
}

const deps = (mux: ReturnType<typeof fakeMux>["mux"], now = () => 0) => ({ mux, self: ["ob"], now, cwd: () => "/agent" });

describe("afterAgentExit", () => {
  test("an agent that ran a while restarts at once and resumes its conversation", () => {
    expect(afterAgentExit({ elapsedMs: 60_000, streak: 0, endedForGood: false })).toEqual({ restart: true, streak: 0, delayMs: 0, args: ["--continue"] });
  });

  test("a session the user ended on purpose, or a hang-up, stays closed", () => {
    expect(afterAgentExit({ elapsedMs: 60_000, streak: 0, endedForGood: true })).toEqual({ restart: false });

    for (const signal of ["SIGHUP", "SIGTERM", "SIGKILL"]) expect(afterAgentExit({ elapsedMs: 60_000, streak: 0, endedForGood: false, signal })).toEqual({ restart: false });
    expect(afterAgentExit({ elapsedMs: 60_000, streak: 0, endedForGood: false, signal: "SIGSEGV" })).toMatchObject({ restart: true });
  });

  test("a resumed agent that exits quickly gets a fresh conversation, then backs off", () => {
    const quick = QUICK_EXIT_MS - 1;
    const first = afterAgentExit({ elapsedMs: quick, streak: 0, endedForGood: false });
    expect(first).toMatchObject({ streak: 1, delayMs: 0, args: ["--continue"] });
    const second = afterAgentExit({ elapsedMs: quick, streak: 1, endedForGood: false });
    expect(second).toMatchObject({ streak: 2, delayMs: 0, args: [] });
    const third = afterAgentExit({ elapsedMs: quick, streak: 2, endedForGood: false });
    expect(third).toMatchObject({ streak: 3, delayMs: 1_000, args: [] });
  });
});

describe("ensureAgentPane", () => {
  beforeEach(resetAgentKeep);

  test("does nothing while Claude's pane is alive", () => {
    const f = fakeMux([pane("1", "sidebar"), pane("2", "w1 · claude")]);
    expect(ensureAgentPane("w1", deps(f.mux))).toBe(false);
    expect(f.opened).toEqual([]);
  });

  test("does nothing when the tab is not listed, so a failed query opens nothing", () => {
    const f = fakeMux([]);
    expect(ensureAgentPane("w1", deps(f.mux))).toBe(false);
    expect(f.opened).toEqual([]);
  });

  test("reopens Claude left of the diff, resuming, and clears an exited corpse", () => {
    const f = fakeMux([pane("1", "sidebar"), pane("3", "w1 · diff"), pane("4", "w1 · claude", { exited: true })]);
    expect(ensureAgentPane("w1", deps(f.mux))).toBe(true);
    expect(f.closed).toEqual(["4"]);
    expect(f.opened).toEqual([{ anchor: "3", direction: "left", title: "w1 · claude", cwd: "/agent", command: ["ob", "claude", "w1", "--", "--continue"], closeOnExit: false }]);
  });

  test("falls back to the terminal, then under the top panel", () => {
    expect(placement([pane("1", "w1 · terminal")], "w1")).toEqual({ anchor: "1", direction: "left" });
    expect(placement([pane("9", "top")], "w1")).toEqual({ anchor: "9", direction: "down" });
    expect(placement([pane("1", "sidebar")], "w1")).toBeUndefined();
  });

  test("waits out the cooldown so a slow listing never opens two", () => {
    const f = fakeMux([pane("1", "sidebar"), pane("3", "w1 · diff")]);
    expect(ensureAgentPane("w1", deps(f.mux, () => 1_000))).toBe(true);
    expect(ensureAgentPane("w1", deps(f.mux, () => 1_000 + REOPEN_COOLDOWN_MS - 1))).toBe(false);
    expect(ensureAgentPane("w1", deps(f.mux, () => 1_000 + REOPEN_COOLDOWN_MS))).toBe(true);
    expect(f.opened).toHaveLength(2);
  });

  test("a refused open waits out the cooldown too, since each try focuses the anchor pane", () => {
    const f = fakeMux([pane("1", "sidebar"), pane("3", "w1 · diff")], false);
    expect(ensureAgentPane("w1", deps(f.mux, () => 0))).toBe(false);
    expect(ensureAgentPane("w1", deps(f.mux, () => 1))).toBe(false);
    expect(f.opened).toHaveLength(1);
  });
});

describe("diff tool", () => {
  test("difftastic wins over delta, which wins over plain git", () => {
    expect(pickDiffTool({ difft: true, delta: true })).toBe("difft");
    expect(pickDiffTool({ difft: false, delta: true })).toBe("delta");
    expect(pickDiffTool({ difft: false, delta: false })).toBe("git");
  });

  test("difft runs through git's external diff, inline unless the side-by-side overlay asks and it is wide enough", () => {
    const wide = difftCommand("abc", DIFFT_SIDE_BY_SIDE_MIN_COLUMNS, true);
    expect(wide.args).toEqual(["-c", "diff.external=difft", "diff", "--ext-diff", "abc"]);
    expect(wide.env).toEqual({ DFT_COLOR: "always", DFT_WIDTH: "100", DFT_DISPLAY: "side-by-side-show-both" });
    expect(difftCommand("abc", DIFFT_SIDE_BY_SIDE_MIN_COLUMNS - 1, true).env.DFT_DISPLAY).toBe("inline");
    expect(difftCommand("abc", 300).env.DFT_DISPLAY).toBe("inline");
  });

  test("delta is inline unless the side-by-side overlay asks and it is wide enough", () => {
    expect(deltaCommand(80)).toContain("--no-side-by-side");
    expect(deltaCommand(200)).toContain("--no-side-by-side");
    expect(deltaCommand(200, true)).toContain("--side-by-side");
    expect(deltaCommand(80, true)).toContain("--no-side-by-side");
  });
});

describe("shouldKeepAgent", () => {
  const live = { created: "now", repos: {} };

  const table: [string, Parameters<typeof shouldKeepAgent>, boolean][] = [
    ["a live, focused workspace", [live, false, true], true],
    ["no such workspace", [undefined, false, true], false],
    ["being removed", [{ ...live, removing: { since: new Date().toISOString() } }, false, true], false],
    ["iceboxed", [{ ...live, iceboxed: { since: new Date().toISOString() } }, false, true], false],
    ["the user ended the session", [live, true, true], false],
    ["its tab is not in view", [live, false, false], false],
  ];

  for (const [name, args, want] of table) test(name, () => expect(shouldKeepAgent(...args)).toBe(want));
});

describe("launchArgs", () => {
  test("with a conversation to resume the arguments are kept", () => {
    expect(launchArgs(["--continue", "--", "/read-handoff"], true, [])).toEqual(["--continue", "--", "/read-handoff"]);
  });

  test("with none, --continue is dropped so the agent starts fresh, and the prompt stays", () => {
    expect(launchArgs(["--continue", "--", "/read-handoff"], false, [])).toEqual(["--", "/read-handoff"]);
    expect(launchArgs(["--continue"], false, [])).toEqual([]);
  });

  test("a restart after a failed first launch repeats that launch's prompt instead of resuming nothing", () => {
    expect(launchArgs(["--continue"], false, ["--", "/start-item 5"])).toEqual(["--", "/start-item 5"]);
    expect(launchArgs(["--continue"], false, ["--continue", "--", "/start-item 5"])).toEqual(["--", "/start-item 5"]);
  });

  test("a prompt that happens to say --continue is left alone", () => {
    expect(withoutContinue(["--", "--continue"])).toEqual(["--", "--continue"]);
    expect(launchArgs(["--", "--continue"], false, [])).toEqual(["--", "--continue"]);
  });
});
