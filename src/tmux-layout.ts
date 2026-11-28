import type { PaneSpec, TabSpec } from "./layout";
import { DEFAULT_LEADER, type Leader, parseLeader, tmuxLeaderLines } from "./leader";
import { shellQuote } from "./util";

/**
 * The sidebar takes a quarter of the window, the rest holds the agent and the extra panes. A percentage survives a
 * window resize, so under tmux this replaces `[sidebar] width` and the sidebar pane's `size`.
 */
export const SIDEBAR_PERCENT = 25;

/** Shell run by tmux hooks: size every pane titled `sidebar` to its share. `##` keeps run-shell from expanding the formats. */
const SIDEBAR_RESIZE = `tmux list-panes -a -F '##{pane_id} ##{pane_title}' | awk '$2=="sidebar"{print $1}' | xargs -r -I{} tmux resize-pane -t {} -x ${SIDEBAR_PERCENT}%`;

/** The border text of a pane with a border status: its title in bold between corners, as the Workspaces frame has it. */
const BORDER_FORMAT = "╭─ #[bold]#{pane_title}#[nobold] ─╮";

/** A tmux command as argv, without the leading `tmux`. */
export type TmuxCommand = string[];

const word = (p: PaneSpec) => p.command.map(shellQuote).join(" ");

/**
 * The command that opens `t`'s window. `first` makes it the session's first window (`new-session`) instead of adding
 * one after the others. `printId` asks tmux to print the new window's id, for a caller that runs the rest as argv.
 */
export function tabOpen(session: string, t: TabSpec, opts: { first: boolean; printId?: boolean }): TmuxCommand {
  const id = opts.printId ? ["-P", "-F", "#{window_id}"] : [];

  return opts.first
    ? ["new-session", "-d", ...id, "-s", session, "-n", t.name, "-c", t.main.cwd, word(t.main)]
    : ["new-window", "-d", ...id, "-t", `${session}:`, "-n", t.name, "-c", t.main.cwd, word(t.main)];
}

/**
 * The commands that fill the window `win` after `tabOpen`: the main pane is the agent; the top panel is split above
 * it and the sidebar is split full-height at the left (`SIDEBAR_PERCENT` of the window), each titled while it is the
 * active pane, so no pane id is needed. The sidebar ends up focused, like zellij. `win` is a window id or index, never a name: tmux reads
 * `=@root` as a window id and finds nothing, and orchestration tabs are named `@...`.
 */
export function tabFill(win: string, t: TabSpec): TmuxCommand[] {
  const title = (p: PaneSpec): TmuxCommand => ["select-pane", "-t", win, "-T", p.name];
  // the active pane's border row carries its title, for the panes the zellij layout frames with edge panes
  const titled = (p: PaneSpec): TmuxCommand[] => (p.frame ? [["set-option", "-p", "-t", win, "pane-border-status", "top"]] : []);

  // with a side pane the top panel spans both (`-f`), and the side split comes first so it targets the main pane
  const side: TmuxCommand[] = t.side
    ? [["split-window", "-h", "-l", "50%", "-t", win, "-c", t.side.cwd, word(t.side)], title(t.side), ...titled(t.side), ["select-pane", "-t", win, "-L"]]
    : [];

  return [
    title(t.main),
    ...titled(t.main),
    ...side,
    ...(t.top ? [["split-window", ...(t.side ? ["-f"] : []), "-b", "-v", "-l", String(t.top.size ?? 5), "-t", win, "-c", t.top.cwd, word(t.top)], title(t.top)] : []),
    ["split-window", "-f", "-b", "-h", "-l", `${SIDEBAR_PERCENT}%`, "-t", win, "-c", t.sidebar.cwd, word(t.sidebar)],
    title(t.sidebar),
  ];
}

/** One argument in tmux's own command syntax: double quotes, escaping `\`, `"` and `$`. */
export const tmuxQuote = (s: string) => `"${s.replace(/[\\"$]/g, "\\$&")}"`;

export const tmuxLine = (cmd: TmuxCommand) => cmd.map(tmuxQuote).join(" ");

/**
 * The tmux script `overbridge layout` prints and `up` sources: the first tab creates the session, the others follow,
 * then the first is selected. Windows are addressed by index, which `base-index 0` in `tmuxConf` makes the tab's
 * position. A pure function of its arguments, like the KDL layout.
 */
export function layoutScript(session: string, tabs: TabSpec[]): string {
  if (!tabs.length) return "";
  const cmds = tabs.flatMap((t, i) => [tabOpen(session, t, { first: i === 0 }), ...tabFill(`${session}:${i}`, t)]);

  return `${[...cmds, ["select-window", "-t", `${session}:0`]].map(tmuxLine).join("\n")}\n`;
}

/**
 * The server config: no prefix and no status bar (so no key is taken from the apps), the mouse on, extended keys
 * forwarded so Shift+Enter and Ctrl+Enter reach Claude, pane titles left to overbridge, and truecolour. The only
 * bindings are the root-table Alt keys that run the CLI's `go` and `next`, and the leader chord (Ctrl+Space by default),
 * which opens a key table whose keys run `overbridge top press`.
 */
export function tmuxConf(self: string[], leader: Leader = parseLeader(DEFAULT_LEADER)!): string {
  const cmd = self.map(shellQuote).join(" ");
  const go = (arg: string) => `run-shell -b ${tmuxQuote(`${cmd} go ${arg}`)}`;

  return `${[
    "set -g base-index 0",
    "set -g prefix None",
    "unbind C-b",
    "set -g status off",
    "set -g mouse on",
    "set -s extended-keys always",
    "set -as terminal-features 'xterm*:extkeys'",
    "set -g allow-set-title off",
    "set -g default-terminal tmux-256color",
    "set -as terminal-overrides ',*:RGB'",
    // tmux draws a cell of border between panes, so a frame of edge panes would have gaps; instead each framed pane
    // gets its title set into the border above it, in the Workspaces frame's grey. The status is set per pane
    // (`titled`), so the sidebar, the top panel and a tab's self-framed panes keep their rows
    "set -g pane-border-style fg=brightblack",
    "set -g pane-active-border-style fg=brightblack",
    "set -g pane-border-lines single",
    `set -g pane-border-format ${tmuxQuote(BORDER_FORMAT)}`,
    "set -g escape-time 10",
    // no dragging a border with the mouse, and the sidebar goes back to its share when a client attaches or resizes
    "unbind -n MouseDrag1Border",
    ...["client-attached", "client-resized"].map((hook) => `set-hook -g ${hook} ${tmuxQuote(`run-shell ${tmuxQuote(SIDEBAR_RESIZE)}`)}`),
    ...Array.from({ length: 9 }, (_, i) => `bind -n M-${i + 1} ${go(String(i + 1))}`),
    `bind -n M-, ${go("prev")}`,
    `bind -n M-. ${go("next")}`,
    `bind -n M-w run-shell -b ${tmuxQuote(`${cmd} next`)}`,
    ...tmuxLeaderLines(self, leader),
  ].join("\n")}\n`;
}
