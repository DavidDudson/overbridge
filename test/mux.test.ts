import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutSpecs, workspaceTabSpec } from "../src/layout";
import { defaultMux, type MuxExec, MuxKind, muxKind, safeExec, TabFocus, tmuxMux, zellijMux } from "../src/mux";
import { layoutScript, tmuxConf, tmuxQuote } from "../src/tmux-layout";

const self = ["ob"];
const ok = (stdout = ""): ReturnType<MuxExec> => ({ ok: true, stdout });

/** An exec that records its calls and answers from `answer` (first match by the joined argv prefix). */
const recorder = (answer: (cmd: string[]) => ReturnType<MuxExec> = () => ok()) => {
  const calls: string[][] = [];
  const exec: MuxExec = (cmd) => (calls.push(cmd), answer(cmd));
  return { calls, exec };
};

describe("muxKind", () => {
  test("the multiplexer you are inside wins, then OVERBRIDGE_MUX, then zellij", () => {
    expect(muxKind({ TMUX: "/tmp/tmux-1/default,1,0" })).toBe(MuxKind.Tmux);
    expect(muxKind({ ZELLIJ: "0" })).toBe(MuxKind.Zellij);
    expect(muxKind({ OVERBRIDGE_MUX: "tmux" })).toBe(MuxKind.Tmux);
    expect(muxKind({ OVERBRIDGE_MUX: "nonsense" })).toBe(MuxKind.Zellij);
    expect(muxKind({})).toBe(MuxKind.Zellij);
  });

  test("defaultMux outside a session reaches a zellij session by name", () => {
    const r = recorder();
    defaultMux({}, r.exec).tabs();
    expect(r.calls[0]!.slice(0, 4)).toEqual(["zellij", "--session", "workspaces", "action"]);
    expect(defaultMux({ TMUX: "x" }, r.exec).kind).toBe(MuxKind.Tmux);
  });
});

describe("zellijMux", () => {
  test("lists tab names and reads the current tab", () => {
    const r = recorder((cmd) => (cmd[2] === "query-tab-names" ? ok("@root\n w1 \n\nw2\n") : ok("name: w1\nposition: 1")));
    const mux = zellijMux(r.exec, { env: {} });
    expect(mux.tabs()).toEqual(["@root", "w1", "w2"]);
    expect(mux.currentTab()).toBe("w1");
    expect(zellijMux(() => ({ ok: false, stdout: "" })).currentTab()).toBeUndefined();
  });

  test("closes a tab by the id list-tabs gives its name, and does nothing for an unknown name", () => {
    const r = recorder((cmd) => (cmd[2] === "list-tabs" ? ok("TAB_ID  POSITION  NAME\n0  0  @root\n2  1  75\n4  2  ENG 1 x\n") : ok()));
    const mux = zellijMux(r.exec);
    expect(mux.closeTab("ENG 1 x")).toBe(true);
    expect(r.calls.at(-1)).toEqual(["zellij", "action", "close-tab-by-id", "4"]);
    r.calls.length = 0;
    expect(mux.closeTab("gone")).toBe(false);
    expect(r.calls.map((c) => c[2])).toEqual(["list-tabs"]);
  });

  test("lists terminal panes, leaving plugin panes out", () => {
    const panes = [
      { id: 1, is_plugin: false, title: "w · claude", tab_name: "w", exited: false },
      { id: 2, is_plugin: true, title: "status", tab_name: "w" },
      { id: 3, title: "w · terminal", tab_name: "w", exited: true },
    ];
    const mux = zellijMux(recorder(() => ok(JSON.stringify(panes))).exec);
    expect(mux.listPanes()).toEqual([
      { id: "1", title: "w · claude", tab: "w", exited: false },
      { id: "3", title: "w · terminal", tab: "w", exited: true },
    ]);
    expect(zellijMux(recorder(() => ok("{nope")).exec).listPanes()).toEqual([]);
  });

  test("opens a pane after focusing its anchor, with the command after `--`", () => {
    const r = recorder();
    zellijMux(r.exec).newPane({ anchor: "7", direction: "down", title: "w · diff", cwd: "/d", command: ["ob", "diff"], closeOnExit: true });
    expect(r.calls).toEqual([
      ["zellij", "action", "focus-pane-id", "terminal_7"],
      ["zellij", "action", "new-pane", "--direction", "down", "--name", "w · diff", "--cwd", "/d", "--close-on-exit", "--", "ob", "diff"],
    ]);
  });

  test("builds and attaches sessions with zellij's own commands", () => {
    const r = recorder((cmd) => (cmd[1] === "list-sessions" ? ok("a\nworkspaces\n") : ok()));
    const mux = zellijMux(r.exec);
    expect(mux.sessionExists("workspaces")).toBe(true);
    expect(mux.sessionExists("nope")).toBe(false);
    mux.killSession("workspaces");
    expect(r.calls.slice(-2)).toEqual([["zellij", "kill-session", "workspaces"], ["zellij", "delete-session", "--force", "workspaces"]]);
    expect(mux.attachCommand("s")).toEqual(["zellij", "attach", "s"]);
    expect(mux.createCommand("s", "/l.kdl")).toEqual(["zellij", "--session", "s", "--new-session-with-layout", "/l.kdl"]);
  });
});

describe("tmuxMux argv", () => {
  const windows = "@0|||@root\n@1|||w1\n@2|||w2\n";
  const mux = (answer?: (cmd: string[]) => ReturnType<MuxExec>) => {
    const r = recorder(answer);
    return { ...r, mux: tmuxMux(r.exec, { session: "s", env: {} }) };
  };

  test("targets windows by id, because a name starting with @ is read as an id even after =", () => {
    const t = mux((cmd) => (cmd[1] === "list-windows" ? ok(windows) : ok()));
    expect(t.mux.goToTab("@root").ok).toBe(true);
    expect(t.calls.at(-1)).toEqual(["tmux", "select-window", "-t", "@0"]);
    expect(t.mux.goToTab("missing").ok).toBe(false);
    expect(t.mux.closeTab("w2")).toBe(true);
    expect(t.calls.at(-1)).toEqual(["tmux", "kill-window", "-t", "@2"]);
  });

  test("reads tabs and panes from -F formats, not from text output", () => {
    const t = mux((cmd) => (cmd[1] === "list-windows" ? ok(windows) : ok("%1|||w1|||w1 · claude|||0\n%2|||w1|||w1 · terminal|||1\n")));
    expect(t.mux.tabs()).toEqual(["@root", "w1", "w2"]);
    expect(t.calls[0]).toEqual(["tmux", "list-windows", "-t", "=s", "-F", "#{window_id}|||#{window_name}"]);
    expect(t.mux.listPanes()).toEqual([
      { id: "%1", tab: "w1", title: "w1 · claude", exited: false },
      { id: "%2", tab: "w1", title: "w1 · terminal", exited: true },
    ]);
  });

  test("moves a tab to its slot by swapping it left past each neighbour", () => {
    const t = mux((cmd) => (cmd[1] === "list-windows" ? ok("@0|||w1\n@1|||w2\n@2|||@root\n") : ok()));
    t.mux.moveTab("@root", 0);
    expect(t.calls.filter((c) => c[1] === "swap-window")).toEqual([
      ["tmux", "swap-window", "-d", "-s", "@2", "-t", "@1"],
      ["tmux", "swap-window", "-d", "-s", "@2", "-t", "@0"],
    ]);
  });

  test("a new pane is split from its anchor, then titled by the id tmux printed", () => {
    const t = mux((cmd) => (cmd[1] === "split-window" ? ok("%9\n") : ok()));
    expect(t.mux.newPane({ anchor: "%3", direction: "right", title: "w · terminal", cwd: "/d", command: ["ob", "shell", "a b"], closeOnExit: false })).toBe(true);
    expect(t.calls).toEqual([
      ["tmux", "split-window", "-P", "-F", "#{pane_id}", "-t", "%3", "-h", "-c", "/d", "ob shell 'a b'"],
      ["tmux", "select-pane", "-t", "%9", "-T", "w · terminal"],
    ]);
  });

  test("focusing a pane selects its window first", () => {
    const t = mux();
    expect(t.mux.focusPane("%4")).toBe(true);
    expect(t.calls).toEqual([["tmux", "select-window", "-t", "%4"], ["tmux", "select-pane", "-t", "%4"]]);
  });

  test("opening a tab runs the window, then fills it by the id tmux printed; foreground selects it", () => {
    const t = mux((cmd) => (cmd[1] === "new-window" ? ok("@7\n") : ok()));
    expect(t.mux.openTab(workspaceTabSpec("w3", self), TabFocus.Foreground).ok).toBe(true);
    expect(t.calls[0]!.slice(0, 8)).toEqual(["tmux", "new-window", "-d", "-P", "-F", "#{window_id}", "-t", "s:"]);
    expect(t.calls.slice(1).every((c) => c[1] === "select-window" || c[c.indexOf("-t") + 1] === "@7")).toBe(true);
    expect(t.calls.at(-1)).toEqual(["tmux", "select-window", "-t", "@7"]);
    t.calls.length = 0;
    t.mux.openTab(workspaceTabSpec("w3", self), TabFocus.Background);
    expect(t.calls.some((c) => c[1] === "select-window")).toBe(false);
  });

  test("a failed window ends the open without filling it", () => {
    const t = mux(() => ({ ok: false, stdout: "", stderr: "no server" }));
    expect(t.mux.openTab(workspaceTabSpec("w3", self), TabFocus.Background)).toEqual({ ok: false, error: "no server" });
    expect(t.calls).toHaveLength(1);
  });

  test("zellij asks for the pane's own session by name when an action finds no active session", () => {
    const t = recorder((cmd) => (cmd[1] === "action" ? { ok: false, stdout: "", stderr: "There is no active session!" } : ok()));
    const z = zellijMux(t.exec, { env: { ZELLIJ: "0", ZELLIJ_SESSION_NAME: "s" } });
    expect(z.goToTab("w").ok).toBe(true);
    expect(t.calls).toEqual([
      ["zellij", "action", "go-to-tab-name", "w"],
      ["zellij", "--session", "s", "action", "go-to-tab-name", "w"],
    ]);
  });

  test("zellij does not retry other failures, or with no session name to ask for", () => {
    const other = recorder(() => ({ ok: false, stdout: "", stderr: "boom" }));
    zellijMux(other.exec, { env: { ZELLIJ: "0", ZELLIJ_SESSION_NAME: "s" } }).goToTab("w");
    expect(other.calls).toHaveLength(1);
    const unnamed = recorder(() => ({ ok: false, stdout: "", stderr: "There is no active session!" }));
    zellijMux(unnamed.exec, { env: { ZELLIJ: "0" } }).goToTab("w");
    expect(unnamed.calls).toHaveLength(1);
  });

  test("sessions are named exactly, and `create` starts the server with the generated config", () => {
    const t = mux();
    expect(t.mux.attachCommand("s")).toEqual(["tmux", "attach-session", "-t", "=s"]);
    expect(tmuxMux(recorder().exec, { session: "s", conf: () => "/c.conf" }).createCommand("s", "/l.tmux")).toEqual([
      "tmux", "-f", "/c.conf", "start-server", ";", "source-file", "/l.tmux", ";", "attach-session", "-t", "=s",
    ]);
    t.mux.killSession("s");
    expect(t.calls.at(-1)).toEqual(["tmux", "kill-session", "-t", "=s"]);
  });

  test("inside a session iff $TMUX is set; the pane id is $TMUX_PANE", () => {
    expect(tmuxMux(recorder().exec, { env: { TMUX: "x", TMUX_PANE: "%2" } }).inSession()).toBe(true);
    expect(tmuxMux(recorder().exec, { env: { TMUX: "x", TMUX_PANE: "%2" } }).ownPaneId()).toBe("%2");
    expect(tmuxMux(recorder().exec, { env: {} }).inSession()).toBe(false);
  });
});

describe("tmux layout script", () => {
  const specs = layoutSpecs(["w1"], ["ob", "x y"], { sidebarWidth: 40 });
  const script = layoutScript("workspaces", specs);
  const lines = script.trimEnd().split("\n");
  const w1Index = specs.findIndex((t) => t.name === "w1");

  test("creates the session with @root, adds the other tabs, and selects the first by index", () => {
    expect(lines[0]).toStartWith('"new-session" "-d" "-s" "workspaces" "-n" "@root"');
    expect(lines.filter((l) => l.startsWith('"new-window"')).map((l) => l.split('" "')[5])).toEqual(specs.slice(1).map((t) => t.name));
    expect(lines.at(-1)).toBe('"select-window" "-t" "workspaces:0"');
  });

  test("no command names a window, since tmux cannot address @root by name", () => {
    expect(lines.filter((l) => /workspaces:=/.test(l))).toEqual([]);
    expect(lines.filter((l) => l.startsWith('"split-window"')).every((l) => /"-t" "workspaces:\d"/.test(l))).toBe(true);
  });

  test("each tab gets the sidebar full-height at the left, the top panel above the agent, and titled panes", () => {
    const w1 = lines.filter((l) => l.includes(`workspaces:${w1Index}`));
    expect(w1.map((l) => l.split(" ")[0])).toEqual(['"select-pane"', '"split-window"', '"select-pane"', '"split-window"', '"select-pane"']);
    expect(w1[1]).toContain('"-b" "-v" "-l" "5"');
    expect(w1[3]).toContain('"-f" "-b" "-h" "-l" "40"');
    expect(w1.filter((l) => l.startsWith('"select-pane"')).map((l) => l.split('"').at(-2))).toEqual(["w1 · claude", "top", "sidebar"]);
  });

  test("quotes what the shell and tmux would otherwise expand", () => {
    expect(tmuxQuote('a"b$c\\d')).toBe('"a\\"b\\$c\\\\d"');
    expect(script).toContain("'x y' sidebar --ws w1");
  });

  test("is a pure function of its arguments, and empty without tabs", () => {
    expect(layoutScript("workspaces", layoutSpecs(["w1"], ["ob", "x y"], { sidebarWidth: 40 }))).toBe(script);
    expect(layoutScript("workspaces", [])).toBe("");
  });

  test("the server config has no prefix, no status bar, extended keys, fixed titles and only Alt root bindings", () => {
    const conf = tmuxConf(["ob"]);
    for (const line of ["set -g prefix None", "set -g status off", "set -g mouse on", "set -s extended-keys always", "set -g allow-set-title off", "set -g base-index 0"]) {
      expect(conf).toContain(`${line}\n`);
    }
    expect(conf.split("\n").filter((l) => l.startsWith("bind")).every((l) => l.startsWith("bind -n M-"))).toBe(true);
    expect(conf).toContain('bind -n M-3 run-shell -b "ob go 3"');
    expect(conf).toContain('bind -n M-w run-shell -b "ob next"');
  });
});

// The same operations against a real tmux server, on a private socket directory. Skipped where tmux is not installed.
describe.skipIf(!Bun.which("tmux"))("tmuxMux against a real tmux", () => {
  let tmp: string;
  const saved = process.env.TMUX_TMPDIR;
  const sleeper = ["sh", "-c", "sleep 60", "x"];

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), "overbridge-tmux-"));
    process.env.TMUX_TMPDIR = tmp;
  });
  afterAll(() => {
    safeExec(["tmux", "kill-server"]);
    saved === undefined ? delete process.env.TMUX_TMPDIR : (process.env.TMUX_TMPDIR = saved);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("a generated layout builds, and every operation works on @-named tabs", () => {
    const script = join(tmp, "layout.tmux");
    const specs = layoutSpecs(["a", "b"], sleeper, { sidebarWidth: 30 });
    const names = specs.map((t) => t.name);
    const [root, work, ...rest] = names as [string, string, ...string[]];
    Bun.write(script, layoutScript("t", specs));
    const mux = tmuxMux(safeExec, { session: "t", env: {} });
    expect(safeExec(["tmux", "-f", "/dev/null", "start-server", ";", "source-file", script]).ok).toBe(true);
    expect(mux.sessionExists("t")).toBe(true);
    expect(mux.tabs()).toEqual(names);

    expect(mux.openTab(workspaceTabSpec("c", sleeper, { sidebarWidth: 30 }), TabFocus.Background).ok).toBe(true);
    expect(mux.tabs().at(-1)).toBe("c");
    expect(mux.currentTab()).toBe(root);

    expect(mux.goToTab(work).ok).toBe(true);
    expect(mux.currentTab()).toBe(work);

    const titles = mux.listPanes().filter((p) => p.tab === "c").map((p) => p.title).sort();
    expect(titles).toEqual(["c · claude", "sidebar", "top"]);

    mux.moveTab("c", 1);
    expect(mux.tabs()).toEqual([root, "c", work, ...rest]);

    const claude = mux.listPanes().find((p) => p.title === "a · claude")!;
    expect(mux.focusPane(claude.id)).toBe(true);
    expect(mux.currentTab()).toBe("a");
    expect(mux.newPane({ anchor: claude.id, direction: "right", title: "a · terminal", cwd: tmp, command: sleeper, closeOnExit: false })).toBe(true);
    const terminal = mux.listPanes().find((p) => p.title === "a · terminal")!;
    expect(mux.closePane(terminal.id)).toBe(true);
    expect(mux.listPanes().some((p) => p.title === "a · terminal")).toBe(false);

    expect(mux.closeTab("c")).toBe(true);
    expect(mux.tabs()).toEqual(names);
    mux.killSession("t");
    expect(mux.sessionExists("t")).toBe(false);
  });
});
