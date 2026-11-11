import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SIDEBAR_WIDTH, sidebarWidth } from "./config";
import type { MuxKind } from "./mux";
import { ORCHESTRATION_TABS, type OrchestrationTab } from "./orchestration";
import { sessionName, worktreePath, wsDir } from "./paths";
import { readState } from "./state";
import { layoutScript, tmuxConf } from "./tmux-layout";

export { SIDEBAR_WIDTH };
/** Rows the top panel takes: the frame's two borders, a row per PR (one is typical) and the row of launchers. */
export const TOP_ROWS = 5;
const q = (s: string) => JSON.stringify(s); // JSON strings are valid KDL strings

export interface LayoutOptions {
  /** Workspaces whose agent should resume its last conversation (`claude --continue`). */
  resume?: ReadonlySet<string>;
  sidebarWidth?: number;
  /** Where each workspace's agent starts (`agentDirs`); a workspace missing here uses its root. */
  agentDirs?: Readonly<Record<string, string>>;
}

export interface TabOptions {
  /** Resume the agent's last conversation (`claude --continue`). */
  resume?: boolean;
  sidebarWidth?: number;
  /** First message for the agent, e.g. `/start-item 51`. Sent after the resumed conversation when `resume` is set. */
  prompt?: string;
  focus?: boolean;
  /** Folder the agent pane opens in (`agentDir`); the workspace root when unset. */
  agentCwd?: string;
}

/** One pane of a tab: a command in a folder, with the title other code finds it by. */
export interface PaneSpec {
  name: string;
  cwd: string;
  /** The program and its arguments. */
  command: string[];
  /** Columns (the sidebar) or rows (the top panel); the pane shares the rest equally when unset. */
  size?: number;
  borderless?: boolean;
}

/**
 * A tab as data, so each multiplexer backend renders it its own way: the sidebar down the left, and beside it
 * the optional top panel over the main pane (the agent, or an orchestration tab's own pane).
 */
export interface TabSpec {
  name: string;
  focus: boolean;
  sidebar: PaneSpec;
  top?: PaneSpec;
  main: PaneSpec;
}

/**
 * One workspace's tab: the sidebar down the left; the rest holds the top panel across the
 * top, then the agent. Terminal and diff panes open to the agent's right from the top panel's buttons.
 */
export function workspaceTabSpec(ws: string, self: string[], opts: TabOptions = {}): TabSpec {
  const width = opts.sidebarWidth ?? SIDEBAR_WIDTH;
  const extra = [...(opts.resume ? ["--continue"] : []), ...(opts.prompt ? ["--", opts.prompt] : [])];
  return {
    name: ws,
    focus: opts.focus ?? false,
    sidebar: { name: "sidebar", cwd: wsDir(ws), command: [...self, "sidebar", "--ws", ws], size: width, borderless: true },
    top: { name: "top", cwd: wsDir(ws), command: [...self, "top", "--ws", ws], size: TOP_ROWS, borderless: true },
    main: { name: `${ws} · claude`, cwd: opts.agentCwd ?? wsDir(ws), command: [...self, "claude", ws, ...extra] },
  };
}

/** An orchestration tab: the sidebar down the left, Claude in the tab's folder filling the rest. No top panel. */
export function orchestrationTabSpec(t: OrchestrationTab, self: string[], opts: Omit<TabOptions, "prompt"> = {}): TabSpec {
  const width = opts.sidebarWidth ?? SIDEBAR_WIDTH;
  const dir = t.dir();
  return {
    name: t.tab,
    focus: opts.focus ?? false,
    sidebar: { name: "sidebar", cwd: dir, command: [...self, "sidebar", "--ws", t.tab], size: width, borderless: true },
    main: {
      name: t.pane ? `${t.tab} · ${t.pane}` : `${t.tab} · claude`,
      cwd: dir,
      command: [...self, ...(t.pane ? [t.pane] : ["claude", t.tab, ...(opts.resume ? ["--continue"] : [])])],
    },
  };
}

const kdlPane = (p: PaneSpec, indent: string, focus = false): string => {
  const [cmd, ...args] = p.command;
  return `${indent}pane name=${q(p.name)} command=${q(cmd!)} cwd=${q(p.cwd)}${p.size === undefined ? "" : ` size=${p.size}`}${p.borderless ? " borderless=true" : ""}${focus ? " focus=true" : ""} {
${indent}  args ${args.map(q).join(" ")}
${indent}}`;
};

/** A tab spec as a zellij `tab` node. */
export function specKdl(t: TabSpec): string {
  const main = t.top
    ? `      pane split_direction="horizontal" {
${kdlPane(t.top, "        ")}
${kdlPane(t.main, "        ")}
      }`
    : kdlPane(t.main, "      ");
  return `  tab name=${q(t.name)}${t.focus ? " focus=true" : ""} {
    pane split_direction="vertical" {
${kdlPane(t.sidebar, "      ", true)}
${main}
    }
  }`;
}

export const tabKdl = (ws: string, self: string[], opts: TabOptions = {}): string => specKdl(workspaceTabSpec(ws, self, opts));

export const orchestrationTabKdl = (t: OrchestrationTab, self: string[], opts: Omit<TabOptions, "prompt"> = {}): string =>
  specKdl(orchestrationTabSpec(t, self, opts));

/** The tabs of a fresh session in order: the orchestration tabs, then one per workspace. The first has focus. */
export function layoutSpecs(workspaces: string[], self: string[], opts: LayoutOptions = {}): TabSpec[] {
  const width = opts.sidebarWidth === undefined ? {} : { sidebarWidth: opts.sidebarWidth };
  const orchestration = ORCHESTRATION_TABS.map((t, i) =>
    orchestrationTabSpec(t, self, { resume: opts.resume?.has(t.tab) ?? false, ...width, focus: i === 0 }),
  );
  return [
    ...orchestration,
    ...workspaces.map((ws, i) =>
      workspaceTabSpec(ws, self, {
        resume: opts.resume?.has(ws) ?? false,
        ...width,
        focus: orchestration.length + i === 0,
        ...(opts.agentDirs?.[ws] ? { agentCwd: opts.agentDirs[ws] } : {}),
      }),
    ),
  ];
}

/**
 * Zellij layout: the orchestration tabs (`orchestrationTabKdl`), then one tab per workspace (`tabKdl`).
 * The first tab has focus. A pure function of its arguments, so regenerating it is idempotent.
 */
export function layoutKdl(workspaces: string[], self: string[], opts: LayoutOptions = {}): string {
  return `layout {
${layoutSpecs(workspaces, self, opts).map(specKdl).join("\n")}
}
`;
}

/** A layout holding just `ws`'s tab, for `zellij action new-tab --layout`. */
export function newTabKdl(ws: string, self: string[], opts: TabOptions = {}): string {
  return `layout {
${tabKdl(ws, self, opts)}
}
`;
}

/** A layout holding just orchestration tab `t`, for reopening it with `zellij action new-tab --layout`. */
export function newOrchestrationTabKdl(t: OrchestrationTab, self: string[], opts: Omit<TabOptions, "prompt" | "resume"> = {}): string {
  return `layout {
${orchestrationTabKdl(t, self, { ...opts, focus: true })}
}
`;
}

/** Zellij's config dir: `$ZELLIJ_CONFIG_DIR`, else `$XDG_CONFIG_HOME/zellij`, else `~/.config/zellij`. */
export function zellijConfigDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (env.ZELLIJ_CONFIG_DIR) return env.ZELLIJ_CONFIG_DIR;
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "zellij");
}

/** A layout file here replaces the generated one. */
export const userLayoutPath = (configDir = zellijConfigDir()) => join(configDir, "layouts", "overbridge.kdl");

/** The directory Claude keeps transcripts in for sessions started in `dir`. */
export const transcriptDir = (dir: string, home = homedir()) => join(home, ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-"));

const hasTranscript = (dir: string, home: string) => {
  const transcripts = transcriptDir(dir, home);
  return existsSync(transcripts) && readdirSync(transcripts).some((f) => f.endsWith(".jsonl"));
};

/**
 * The folder `ws`'s agent starts in, so Claude finds the repo's `overbridge.yml` from its cwd. One repo: that
 * repo's worktree. Several: the first claimed, which is the repo `overbridge start` was given. None: the workspace
 * root. A workspace whose only transcripts are in its root keeps starting there, so `--continue` still resumes it.
 */
export function agentDir(ws: string, repos: readonly string[], home = homedir()): string {
  const [first] = repos;
  if (!first) return wsDir(ws);
  const repo = worktreePath(ws, first);
  return !hasTranscript(repo, home) && hasTranscript(wsDir(ws), home) ? wsDir(ws) : repo;
}

/** `agentDir` for a workspace in the state file; the root for one that is not in it. */
export const agentDirOf = (ws: string, home = homedir()) => agentDir(ws, Object.keys(readState().workspaces[ws]?.repos ?? {}), home);

/**
 * Workspaces and orchestration tabs with a Claude transcript to resume. Reads the disk, so callers pass the
 * result to `layoutKdl`.
 */
export function resumable(workspaces: string[], home = homedir(), agentDirs: Readonly<Record<string, string>> = {}): Set<string> {
  return new Set([
    ...workspaces.filter((ws) => hasTranscript(agentDirs[ws] ?? wsDir(ws), home)),
    ...ORCHESTRATION_TABS.filter((t) => !t.pane && hasTranscript(t.dir(), home)).map((t) => t.tab),
  ]);
}

/** `text` is KDL for zellij and a command script for tmux; tmux also gets the server `conf` it starts with. */
export type LayoutChoice = { source: "user"; path: string } | { source: "generated"; text: string; conf?: string };

/**
 * The layout `up` would use. Zellij: the user's file when it exists, else the generated KDL. Tmux has no layout
 * file, so it is always the generated script.
 */
export function chooseLayout(workspaces: string[], self: string[], kind: MuxKind = "zellij", session = sessionName(), userPath = userLayoutPath()): LayoutChoice {
  if (kind === "zellij" && existsSync(userPath)) return { source: "user", path: userPath };
  const agentDirs = Object.fromEntries(workspaces.map((ws) => [ws, agentDirOf(ws)]));
  const opts = { resume: resumable(workspaces, homedir(), agentDirs), sidebarWidth: sidebarWidth(), agentDirs };
  return kind === "tmux"
    ? { source: "generated", text: layoutScript(session, layoutSpecs(workspaces, self, opts)), conf: tmuxConf(self) }
    : { source: "generated", text: layoutKdl(workspaces, self, opts) };
}
