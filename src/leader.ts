import { PRESS_KEYS } from "./keys";
import { shellQuote } from "./util";

/**
 * The leader chord: one key the multiplexer takes from the focused pane (so Claude, which owns the keyboard, never
 * sees it), then a button key of the top panel. `overbridge top press <key>` does the rest. Pure: it renders
 * the tmux bindings and the zellij keybinds block for a leader.
 *
 * The leader is `[keys] leader` in repos.toml, written `ctrl-space`, `alt-space` or `ctrl-` / `alt-` and one letter.
 */
export const DEFAULT_LEADER = "ctrl-space";

export interface Leader {
  mod: "ctrl" | "alt";
  /** `space` or one lowercase letter. */
  key: string;
}

/** The leader `text` names, or undefined when it is not `ctrl-` or `alt-` and `space` or a letter. */
export function parseLeader(text: string): Leader | undefined {
  const m = /^(ctrl|alt)-(space|[a-z])$/.exec(text.trim().toLowerCase());

  return m ? { mod: m[1] === "alt" ? "alt" : "ctrl", key: m[2]! } : undefined;
}

/** tmux's name for the leader: `C-Space`, `M-x`. */
export const tmuxKey = (l: Leader): string => `${l.mod === "ctrl" ? "C" : "M"}-${l.key === "space" ? "Space" : l.key}`;

/** zellij's name for the leader: `Ctrl Space`, `Alt x`. */
export const zellijKey = (l: Leader): string => `${l.mod === "ctrl" ? "Ctrl" : "Alt"} ${l.key === "space" ? "Space" : l.key}`;

const TABLE = "overbridge";

const quote = (s: string) => `"${s.replace(/[\\"$`]/g, "\\$&")}"`;

/** The tmux config lines: the leader enters the `overbridge` key table, and each press key in it runs `top press`. */
export function tmuxLeaderLines(self: string[], leader: Leader): string[] {
  const cmd = self.map(shellQuote).join(" ");

  return [`bind -n ${tmuxKey(leader)} switch-client -T ${TABLE}`, ...PRESS_KEYS.map((k) => `bind -T ${TABLE} ${k} run-shell -b ${quote(`${cmd} top press ${k}`)}`)];
}

/**
 * The zellij keybinds block for `leader`, to merge into `config.kdl`. Zellij has no user-defined modes, so the chord
 * borrows the built-in `tmux` mode with its defaults cleared; Esc or any other key leaves it. Each press runs
 * `overbridge top press` in a floating pane that closes at once.
 */
export function zellijKeybinds(self: string[], leader: Leader): string {
  const run = (k: string) => `Run ${self.map(quote).join(" ")} "top" "press" "${k}" { close_on_exit true; floating true; }`;
  const binds = PRESS_KEYS.map((k) => `        bind ${quote(k)} { ${run(k)}; SwitchToMode "normal"; }`);

  return [
    "keybinds {",
    '    shared_except "locked" {',
    `        bind ${quote(zellijKey(leader))} { SwitchToMode "tmux"; }`,
    "    }",
    "    tmux clear-defaults=true {",
    '        bind "Esc" { SwitchToMode "normal"; }',
    ...binds,
    "    }",
    "}",
    "",
  ].join("\n");
}
