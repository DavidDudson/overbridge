import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SIDEBAR_WIDTH, sidebarWidth } from "./config";
import { ORCHESTRATION_TABS, type OrchestrationTab } from "./orchestration";
import { wsDir } from "./paths";

export { SIDEBAR_WIDTH };
/** Rows the top panel takes: the frame's two borders, a row per PR (one is typical) and the row of launchers. */
export const TOP_ROWS = 5;
const q = (s: string) => JSON.stringify(s); // JSON strings are valid KDL strings

export interface LayoutOptions {
  /** Workspaces whose agent should resume its last conversation (`claude --continue`). */
  resume?: ReadonlySet<string>;
  sidebarWidth?: number;
}

export interface TabOptions {
  /** Resume the agent's last conversation (`claude --continue`). */
  resume?: boolean;
  sidebarWidth?: number;
  /** First message for the agent, e.g. `/start-item 51`. Sent after the resumed conversation when `resume` is set. */
  prompt?: string;
  focus?: boolean;
}

/**
 * One workspace's tab: the sidebar down the left; the rest holds the top panel across the
 * top, then the agent. Terminal and diff panes open to the agent's right from the top panel's buttons.
 */
export function tabKdl(ws: string, self: string[], opts: TabOptions = {}): string {
  const [cmd, ...baseArgs] = self;
  const width = opts.sidebarWidth ?? SIDEBAR_WIDTH;
  const args = (...rest: string[]) => [...baseArgs, ...rest].map(q).join(" ");
  const extra = [...(opts.resume ? ["--continue"] : []), ...(opts.prompt ? ["--", opts.prompt] : [])];
  const agent = args("claude", ws, ...extra);
  return `  tab name=${q(ws)}${opts.focus ? " focus=true" : ""} {
    pane split_direction="vertical" {
      pane name=${q("sidebar")} command=${q(cmd!)} cwd=${q(wsDir(ws))} size=${width} borderless=true focus=true {
        args ${args("sidebar", "--ws", ws)}
      }
      pane split_direction="horizontal" {
        pane name=${q("top")} command=${q(cmd!)} cwd=${q(wsDir(ws))} size=${TOP_ROWS} borderless=true {
          args ${args("top", "--ws", ws)}
        }
        pane name=${q(`${ws} · claude`)} command=${q(cmd!)} cwd=${q(wsDir(ws))} {
          args ${agent}
        }
      }
    }
  }`;
}

/** An orchestration tab: the sidebar down the left, Claude in the tab's folder filling the rest. No top panel. */
export function orchestrationTabKdl(t: OrchestrationTab, self: string[], opts: Omit<TabOptions, "prompt"> = {}): string {
  const [cmd, ...baseArgs] = self;
  const width = opts.sidebarWidth ?? SIDEBAR_WIDTH;
  const args = (...rest: string[]) => [...baseArgs, ...rest].map(q).join(" ");
  const dir = t.dir();
  return `  tab name=${q(t.tab)}${opts.focus ? " focus=true" : ""} {
    pane split_direction="vertical" {
      pane name=${q("sidebar")} command=${q(cmd!)} cwd=${q(dir)} size=${width} borderless=true focus=true {
        args ${args("sidebar", "--ws", t.tab)}
      }
      pane name=${q(`${t.tab} · claude`)} command=${q(cmd!)} cwd=${q(dir)} {
        args ${args("claude", t.tab, ...(opts.resume ? ["--continue"] : []))}
      }
    }
  }`;
}

const TAB_TEMPLATE = `  default_tab_template {
    children
    pane size=1 borderless=true {
      plugin location="zellij:status-bar"
    }
  }`;

/**
 * Zellij layout: the orchestration tabs (`orchestrationTabKdl`), then one tab per workspace (`tabKdl`).
 * The first tab has focus. A pure function of its arguments, so regenerating it is idempotent.
 */
export function layoutKdl(workspaces: string[], self: string[], opts: LayoutOptions = {}): string {
  const width = opts.sidebarWidth === undefined ? {} : { sidebarWidth: opts.sidebarWidth };
  const orchestration = ORCHESTRATION_TABS.map((t, i) =>
    orchestrationTabKdl(t, self, { resume: opts.resume?.has(t.tab) ?? false, ...width, focus: i === 0 }),
  );
  const tabs = [
    ...orchestration,
    ...workspaces.map((ws, i) => tabKdl(ws, self, { resume: opts.resume?.has(ws) ?? false, ...width, focus: orchestration.length + i === 0 })),
  ];
  return `layout {
${TAB_TEMPLATE}
${tabs.join("\n")}
}
`;
}

/** A layout holding just `ws`'s tab, for `zellij action new-tab --layout`. */
export function newTabKdl(ws: string, self: string[], opts: TabOptions = {}): string {
  return `layout {
${TAB_TEMPLATE}
${tabKdl(ws, self, opts)}
}
`;
}

/** A layout holding just orchestration tab `t`, for reopening it with `zellij action new-tab --layout`. */
export function newOrchestrationTabKdl(t: OrchestrationTab, self: string[], opts: Omit<TabOptions, "prompt" | "resume"> = {}): string {
  return `layout {
${TAB_TEMPLATE}
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
 * Workspaces and orchestration tabs with a Claude transcript to resume. Reads the disk, so callers pass the
 * result to `layoutKdl`.
 */
export function resumable(workspaces: string[], home = homedir()): Set<string> {
  return new Set([
    ...workspaces.filter((ws) => hasTranscript(wsDir(ws), home)),
    ...ORCHESTRATION_TABS.filter((t) => hasTranscript(t.dir(), home)).map((t) => t.tab),
  ]);
}

export type LayoutChoice = { source: "user"; path: string } | { source: "generated"; kdl: string };

/** The layout `up` would use: the user's file when it exists, else the generated one. */
export function chooseLayout(workspaces: string[], self: string[], userPath = userLayoutPath()): LayoutChoice {
  if (existsSync(userPath)) return { source: "user", path: userPath };
  return { source: "generated", kdl: layoutKdl(workspaces, self, { resume: resumable(workspaces), sidebarWidth: sidebarWidth() }) };
}
