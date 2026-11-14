import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { specKdl, type TabSpec } from "./layout";
import { metaDir, sessionName as configuredSession } from "./paths";
import { tabFill, tabOpen } from "./tmux-layout";
import { run, shellQuote } from "./util";

/** Runs one multiplexer command; tests pass a fake to see the calls without a session. */
export type MuxExec = (cmd: string[]) => { ok: boolean; stdout: string; stderr?: string };

export const MuxKind = { Zellij: "zellij", Tmux: "tmux" } as const;
export type MuxKind = (typeof MuxKind)[keyof typeof MuxKind];

/** A pane as the multiplexer lists it. `id` is what `focusPane` and `closePane` take back. */
export interface MuxPane {
  id: string;
  title: string;
  tab: string;
  exited: boolean;
}

export interface NewPane {
  /** The pane the new one opens beside. */
  anchor: string;
  direction: "right" | "down";
  title: string;
  cwd: string;
  /** Empty: the multiplexer's default shell. */
  command: string[];
  /** Close the pane when its command exits (tmux always does). */
  closeOnExit: boolean;
}

/** Where focus ends up after a tab opens: back on the tab you were on, or on the new tab. */
export const TabFocus = { Background: "background", Foreground: "foreground" } as const;
export type TabFocus = (typeof TabFocus)[keyof typeof TabFocus];

export interface MuxResult {
  ok: boolean;
  error?: string;
}

/**
 * Everything overbridge asks of the terminal multiplexer. Names are exact tab names; each backend does its own
 * quoting and parsing, so no other module knows a multiplexer's command line or its output format.
 */
export interface Mux {
  readonly kind: MuxKind;
  /** Whether this process runs inside the multiplexer's session. */
  inSession(): boolean;
  /** The session's name, so two sessions never share a history. */
  sessionName(): string;
  /** This process's own pane id, as `listPanes` reports it. */
  ownPaneId(): string | undefined;
  /** Tab names in the multiplexer's order; empty when it cannot say. */
  tabs(): string[];
  /** The focused tab; undefined when it cannot say. */
  currentTab(): string | undefined;
  goToTab(name: string): MuxResult;
  /** Open `spec` as a new tab. Foreground leaves it focused; background returns focus to the tab you were on. */
  openTab(spec: TabSpec, focus: TabFocus): MuxResult;
  /** Close the tab named `name`, whichever tab has focus. */
  closeTab(name: string): boolean;
  /** Move the tab named `name` to position `index` (0-based), shifting the tabs between. */
  moveTab(name: string, index: number): void;
  listPanes(): MuxPane[];
  focusPane(id: string): boolean;
  closePane(id: string): boolean;
  newPane(req: NewPane): boolean;
  /** Whether the named session is running. */
  sessionExists(name: string): boolean;
  killSession(name: string): void;
  /** The command that attaches to `name`. */
  attachCommand(name: string): string[];
  /** The command that creates the session `name` from the generated `layout` file and attaches to it. */
  createCommand(name: string, layout: string): string[];
}

/** `run`, but a missing binary reads as a failed call, the same as running outside a session. */
export const safeExec: MuxExec = (cmd) => {
  try {
    return run(cmd);
  } catch {
    return { ok: false, stdout: "" };
  }
};

const lines = (text: string) => text.split("\n").map((s) => s.trim()).filter(Boolean);
const result = (r: { ok: boolean; stdout: string; stderr?: string }): MuxResult => (r.ok ? { ok: true } : { ok: false, error: r.stderr || r.stdout });

export interface ZellijOptions {
  /** Reach the session by name, for a caller outside it (a window-manager key has no `$ZELLIJ`). */
  session?: string;
  env?: Record<string, string | undefined>;
  metaDir?: () => string;
}

/** The zellij backend: `zellij action ...`, text output parsed with regexes. */
export function zellijMux(exec: MuxExec = safeExec, opts: ZellijOptions = {}): Mux {
  const env = opts.env ?? process.env;
  const meta = opts.metaDir ?? metaDir;
  const actIn = (session: string | undefined, args: string[]) => exec(session === undefined ? ["zellij", "action", ...args] : ["zellij", "--session", session, "action", ...args]);
  // "There is no active session!" can be a transient miss (a busy server) while this pane's own session is alive,
  // so ask for that session by name before giving up
  const act = (...args: string[]) => {
    const r = actIn(opts.session, args);
    const ownSession = env.ZELLIJ_SESSION_NAME;
    if (r.ok || opts.session !== undefined || !ownSession || !/no active session/i.test(`${r.stderr ?? ""}${r.stdout}`)) return r;
    // a stale name fails differently; report the first error, the one that says what went wrong
    const byName = actIn(ownSession, args);
    return byName.ok ? byName : r;
  };
  const target = (id: string) => `terminal_${id}`;
  const tabs = () => {
    const r = act("query-tab-names");
    return r.ok ? lines(r.stdout) : [];
  };
  const currentTab = () => {
    const r = act("current-tab-info");
    return r.ok ? /^name: (.+)$/m.exec(r.stdout)?.[1]?.trim() : undefined;
  };
  return {
    kind: MuxKind.Zellij,
    inSession: () => !!env.ZELLIJ,
    sessionName: () => env.ZELLIJ_SESSION_NAME || "default",
    ownPaneId: () => env.ZELLIJ_PANE_ID,
    tabs,
    currentTab,
    goToTab: (name) => result(act("go-to-tab-name", name)),
    openTab(spec, focus) {
      const dir = join(meta(), "tabs");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `${spec.name}.kdl`);
      writeFileSync(file, `layout {\n${specKdl({ ...spec, focus: true })}\n}\n`);
      const back = focus === TabFocus.Background ? currentTab() : undefined;
      const r = act("new-tab", "--layout", file, "--name", spec.name);
      if (!r.ok) return result(r);
      // new-tab always focuses the tab it makes, so go back to the pane you left
      if (back !== undefined) act("go-to-tab-name", back);
      return { ok: true };
    },
    closeTab(name) {
      const id = act("list-tabs").stdout.split("\n").flatMap((line) => {
        const m = /^\s*(\d+)\s+\d+\s+(.+?)\s*$/.exec(line);
        return m && m[2] === name ? [m[1]!] : [];
      })[0];
      return id !== undefined && act("close-tab-by-id", id).ok;
    },
    moveTab(name, index) {
      const at = tabs().indexOf(name);
      Array.from({ length: Math.max(0, at - index) }).forEach(() => act("move-tab", "left"));
    },
    listPanes() {
      const r = act("list-panes", "--json");
      try {
        const panes = (r.ok ? JSON.parse(r.stdout) : []) as { id: number; is_plugin?: boolean; title?: string; tab_name?: string; exited?: boolean }[];
        return panes.filter((p) => !p.is_plugin).map((p) => ({ id: String(p.id), title: p.title ?? "", tab: p.tab_name ?? "", exited: p.exited === true }));
      } catch {
        return [];
      }
    },
    // focusing a pane that already has focus exits 2, which callers treat as success
    focusPane: (id) => act("focus-pane-id", target(id)).ok,
    closePane: (id) => act("close-pane", "--pane-id", target(id)).ok,
    newPane(req) {
      act("focus-pane-id", target(req.anchor));
      const args = ["new-pane", "--direction", req.direction, "--name", req.title, "--cwd", req.cwd];
      if (req.closeOnExit) args.push("--close-on-exit");
      if (req.command.length) args.push("--", ...req.command);
      return act(...args).ok;
    },
    sessionExists: (name) => lines(exec(["zellij", "list-sessions", "--short", "--no-formatting"]).stdout).includes(name),
    killSession(name) {
      exec(["zellij", "kill-session", name]);
      exec(["zellij", "delete-session", "--force", name]);
    },
    attachCommand: (name) => ["zellij", "attach", name],
    createCommand: (name, layout) => ["zellij", "--session", name, "--new-session-with-layout", layout],
  };
}

/** Between the fields of one `-F` row; pane titles contain spaces and dots, so a space would not do. */
const SEP = "|||";

export interface TmuxOptions {
  session?: string;
  env?: Record<string, string | undefined>;
  /** The tmux config `createCommand` starts the server with. */
  conf?: () => string;
}

/** The tmux backend: `-F` formats for every value, window ids for every target. */
export function tmuxMux(exec: MuxExec = safeExec, opts: TmuxOptions = {}): Mux {
  const env = opts.env ?? process.env;
  const session = opts.session ?? configuredSession();
  const tmux = (...args: string[]) => exec(["tmux", ...args]);
  const windows = () => {
    const r = tmux("list-windows", "-t", `=${session}`, "-F", `#{window_id}${SEP}#{window_name}`);
    return r.ok ? lines(r.stdout).map((l) => ({ id: l.split(SEP)[0]!, name: l.split(SEP)[1] ?? "" })) : [];
  };
  // windows are addressed by id: a name starting with `@` (an orchestration tab) reads as a window id even after `=`
  const windowId = (name: string) => windows().find((w) => w.name === name)?.id;
  return {
    kind: MuxKind.Tmux,
    inSession: () => !!env.TMUX,
    sessionName: () => session,
    ownPaneId: () => env.TMUX_PANE,
    tabs: () => windows().map((w) => w.name),
    currentTab() {
      const r = tmux("display-message", "-p", "-t", `=${session}:`, "#{window_name}");
      return r.ok ? r.stdout.trim() || undefined : undefined;
    },
    goToTab(name) {
      const id = windowId(name);
      return id === undefined ? { ok: false, error: `no tab ${name}` } : result(tmux("select-window", "-t", id));
    },
    openTab(spec, focus) {
      const opened = tmux(...tabOpen(session, spec, { first: false, printId: true }));
      if (!opened.ok) return result(opened);
      const id = opened.stdout.trim();
      for (const cmd of tabFill(id, spec)) {
        const r = tmux(...cmd);
        if (!r.ok) return result(r);
      }
      return focus === TabFocus.Foreground ? result(tmux("select-window", "-t", id)) : { ok: true };
    },
    closeTab(name) {
      const id = windowId(name);
      return id !== undefined && tmux("kill-window", "-t", id).ok;
    },
    moveTab(name, index) {
      const order = windows().map((w) => w.id);
      const id = windowId(name);
      if (id === undefined) return;
      for (let at = order.indexOf(id); at > index; at--) {
        tmux("swap-window", "-d", "-s", id, "-t", order[at - 1]!);
        [order[at - 1], order[at]] = [order[at]!, order[at - 1]!];
      }
    },
    listPanes() {
      const r = tmux("list-panes", "-s", "-t", `=${session}`, "-F", ["#{pane_id}", "#{window_name}", "#{pane_title}", "#{pane_dead}"].join(SEP));
      if (!r.ok) return [];
      return lines(r.stdout).map((l) => {
        const [id = "", tab = "", title = "", dead = "0"] = l.split(SEP);
        return { id, tab, title, exited: dead === "1" };
      });
    },
    focusPane: (id) => tmux("select-window", "-t", id).ok && tmux("select-pane", "-t", id).ok,
    closePane: (id) => tmux("kill-pane", "-t", id).ok,
    newPane(req) {
      const args = ["split-window", "-P", "-F", "#{pane_id}", "-t", req.anchor, req.direction === "right" ? "-h" : "-v", "-c", req.cwd];
      if (req.command.length) args.push(req.command.map(shellQuote).join(" "));
      const r = tmux(...args);
      if (!r.ok) return false;
      tmux("select-pane", "-t", r.stdout.trim(), "-T", req.title);
      return true;
    },
    sessionExists: (name) => tmux("has-session", "-t", `=${name}`).ok,
    killSession: (name) => void tmux("kill-session", "-t", `=${name}`),
    attachCommand: (name) => ["tmux", "attach-session", "-t", `=${name}`],
    createCommand: (name, layout) => ["tmux", ...(opts.conf ? ["-f", opts.conf()] : []), "start-server", ";", "source-file", layout, ";", "attach-session", "-t", `=${name}`],
  };
}

/** Which multiplexer this process uses: the one it runs inside, else `$OVERBRIDGE_MUX`, else zellij. */
export function muxKind(env: Record<string, string | undefined> = process.env): MuxKind {
  if (env.TMUX) return MuxKind.Tmux;
  if (env.ZELLIJ) return MuxKind.Zellij;
  return env.OVERBRIDGE_MUX === MuxKind.Tmux ? MuxKind.Tmux : MuxKind.Zellij;
}

/** Where `up` writes the tmux config for the server it starts. */
export const tmuxConfPath = () => join(metaDir(), "tmux.conf");

/** Where `up` writes the generated layout: the script for tmux, KDL for zellij. */
export const layoutPath = (kind: MuxKind) => join(metaDir(), kind === MuxKind.Tmux ? "layout.tmux" : "layout.kdl");

/**
 * The multiplexer for this process. Outside its session (a window-manager key) it reaches the session by name,
 * so `overbridge go` works from anywhere.
 */
export function defaultMux(env: Record<string, string | undefined> = process.env, exec: MuxExec = safeExec): Mux {
  if (muxKind(env) === MuxKind.Tmux) return tmuxMux(exec, { env, conf: tmuxConfPath });
  return zellijMux(exec, { env, ...(env.ZELLIJ ? {} : { session: configuredSession() }) });
}
