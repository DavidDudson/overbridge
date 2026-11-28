import { PRESS_KEYS } from "./keys";
import { shellQuote } from "./util";

/**
 * The leader chord: one key the multiplexer takes from the focused pane (so Claude, which owns the keyboard, never
 * sees it), then a button key of the top panel. `overbridge top press <key>` does the rest. Pure: it renders
 * the tmux bindings and the zellij keybinds block for a leader.
 *
 * The leader is `[keys] leader` in repos.toml: `ctrl-space`, `alt-space`, `ctrl-`/`alt-` and a free letter, or `off`.
 */
export const DEFAULT_LEADER_TEXT = "ctrl-space";

/** `[keys] leader = "off"` binds no chord at all. */
export const LEADER_OFF = "off";

export interface Leader {
  mod: "ctrl" | "alt";
  /** `space` or one lowercase letter. */
  key: string;
}

export const DEFAULT_LEADER: Leader = { mod: "ctrl", key: "space" };

/** Letters whose Ctrl chord is a terminal control byte (c, d, z, h, i, j, l, m): taking one would break interrupt, EOF, suspend, backspace, tab or enter in every pane. */
const CONTROL_LETTERS = new Set(["c", "d", "z", "h", "i", "j", "l", "m"]);

/** Alt chords the generated tmux config already binds (`⌥w` runs `next`). */
const TAKEN_ALT = new Set(["w"]);

/** The leader `text` names, or undefined when it is not `ctrl-` or `alt-` and `space` or a letter that is free to take. */
export function parseLeader(text: string): Leader | undefined {
  const m = /^(ctrl|alt)-(space|[a-z])$/.exec(text.trim().toLowerCase());

  if (!m) return undefined;
  const mod = m[1] === "alt" ? "alt" : "ctrl";
  const key = m[2]!;

  if (mod === "ctrl" && CONTROL_LETTERS.has(key)) return undefined;

  if (mod === "alt" && TAKEN_ALT.has(key)) return undefined;

  return { mod, key };
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
 * borrows the built-in `tmux` mode with its defaults cleared; only Esc or a press key leaves it. Each press runs
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
