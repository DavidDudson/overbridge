import { describe, expect, test } from "bun:test";
import { pickerHit, renderPicker, showTerminal, SyncStep, syncPlan, terminalTitle, toggleTerminal, type TerminalDeps } from "../src/explore";
import { type Mux, type MuxPane, type NewPane, zellijMux } from "../src/mux";
import { buttons, type TopSnapshot } from "../src/top";
import { ORCHESTRATION_TABS } from "../src/orchestration";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("syncPlan", () => {
  test("adds a missing checkout", () => {
    expect(syncPlan({ exists: false, dirty: false, onMain: true })).toBe(SyncStep.Add);
  });

  test("moves a clean checkout on the default branch's history", () => {
    expect(syncPlan({ exists: true, dirty: false, onMain: true })).toBe(SyncStep.Move);
  });

  test("leaves local changes alone", () => {
    expect(syncPlan({ exists: true, dirty: true, onMain: true })).toBe(SyncStep.KeepDirty);
  });

  test("leaves local commits alone", () => {
    expect(syncPlan({ exists: true, dirty: false, onMain: false })).toBe(SyncStep.KeepAhead);
  });
});

describe("renderPicker", () => {
  test("marks checked-out repos and inverts the selected row", () => {
    const rows = renderPicker({ repos: ["api", "web"], selected: 1, checkedOut: new Set(["web"]), width: 40 });

    expect(strip(rows[2]!).trim()).toBe("○ api");
    expect(strip(rows[3]!).trim()).toBe("● web");
    expect(rows[3]).toContain("\x1b[7m");
    expect(rows[2]).not.toContain("\x1b[7m");
  });

  test("says how to register a repo when there are none", () => {
    expect(renderPicker({ repos: [], selected: 0, checkedOut: new Set(), width: 80 }).join("\n")).toContain("overbridge repo add");
  });

  test("pickerHit maps a screen row to its repo", () => {
    expect(pickerHit(1, 2)).toBeUndefined();
    expect(pickerHit(2, 2)).toBe(0);
    expect(pickerHit(3, 2)).toBe(1);
    expect(pickerHit(4, 2)).toBeUndefined();
  });
});

function fakeMux(panes: MuxPane[]) {
  const opened: NewPane[] = [];
  const closed: string[] = [];

  const mux: Mux = {
    ...zellijMux(() => ({ ok: false, stdout: "" })),
    ownPaneId: () => "self",
    listPanes: () => panes,
    newPane: (req: NewPane) => {
      opened.push(req);

      return true;
    },
    closePane: (id: string) => {
      closed.push(id);

      return true;
    },
  };

  const deps: TerminalDeps = { mux, self: ["overbridge"] };

  return { deps, opened, closed };
}

const pane = (id: string, title: string): MuxPane => ({ id, title, tab: "@explore", exited: false });

describe("explore terminal", () => {
  test("showTerminal opens one below the panel, in the repo's shell", () => {
    const { deps, opened } = fakeMux([]);

    expect(showTerminal("web", deps)).toBeUndefined();
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ anchor: "self", direction: "down", title: terminalTitle("web"), command: ["overbridge", "explore", "shell", "web"] });
  });

  test("showTerminal swaps another repo's terminal for this one's and keeps an open one", () => {
    const swap = fakeMux([pane("1", terminalTitle("api"))]);
    showTerminal("web", swap.deps);
    expect(swap.closed).toEqual(["1"]);
    expect(swap.opened).toHaveLength(1);

    const keep = fakeMux([pane("2", terminalTitle("web"))]);
    showTerminal("web", keep.deps);
    expect(keep.closed).toEqual([]);
    expect(keep.opened).toEqual([]);
  });

  test("toggleTerminal closes an open one and opens a missing one", () => {
    const open = fakeMux([pane("2", terminalTitle("web"))]);
    toggleTerminal("web", open.deps);
    expect(open.closed).toEqual(["2"]);

    const missing = fakeMux([]);
    toggleTerminal("web", missing.deps);
    expect(missing.opened).toHaveLength(1);
  });
});

describe("explore panel", () => {
  test("@explore is the last orchestration tab and runs the explore pane", () => {
    expect(ORCHESTRATION_TABS.at(-1)).toMatchObject({ tab: "@explore", pane: "explore" });
  });

  test("offers only the panes it is given, and a back button on b", () => {
    const snap: TopSnapshot = { ws: "@explore", dir: "/x", links: [], apps: [], editor: "zed", panes: ["terminal"], back: "web · repos" };
    const list = buttons(snap);

    expect(list.map((b) => b.key)).toEqual(["b", "e", "t"]);
    expect(list[0]!.action).toEqual({ kind: "back" });
  });
});
