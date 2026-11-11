import { SIDEBAR_WIDTH } from "./config";
import type { PaneSpec, TabSpec } from "./layout";
import { shellQuote } from "./util";

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
 * it and the sidebar is split full-height at the left, each titled while it is the active pane, so no pane id is
 * needed. The sidebar ends up focused, like zellij. `win` is a window id or index, never a name: tmux reads
 * `=@root` as a window id and finds nothing, and orchestration tabs are named `@...`.
 */
export function tabFill(win: string, t: TabSpec): TmuxCommand[] {
  const title = (p: PaneSpec): TmuxCommand => ["select-pane", "-t", win, "-T", p.name];
  return [
    title(t.main),
    ...(t.top ? [["split-window", "-b", "-v", "-l", String(t.top.size ?? 5), "-t", win, "-c", t.top.cwd, word(t.top)], title(t.top)] : []),
    ["split-window", "-f", "-b", "-h", "-l", String(t.sidebar.size ?? SIDEBAR_WIDTH), "-t", win, "-c", t.sidebar.cwd, word(t.sidebar)],
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
 * bindings are the root-table Alt keys that run the CLI's `go` and `next`.
 */
export function tmuxConf(self: string[]): string {
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
    "set -g pane-border-style fg=black",
    "set -g pane-active-border-style fg=black",
    "set -g escape-time 10",
    ...Array.from({ length: 9 }, (_, i) => `bind -n M-${i + 1} ${go(String(i + 1))}`),
    `bind -n M-, ${go("prev")}`,
    `bind -n M-. ${go("next")}`,
    `bind -n M-w run-shell -b ${tmuxQuote(`${cmd} next`)}`,
  ].join("\n")}\n`;
}
