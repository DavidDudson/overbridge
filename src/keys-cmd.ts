import { leaderKey } from "./config";
import { allBindings, PRESS_KEYS } from "./keys";
import { tmuxKey, zellijKeybinds, zellijKey } from "./leader";
import { selfCommand } from "./paths";

/**
 * `overbridge keys`: the shared key table and the leader chord. With `zellij` it prints only the keybinds block to
 * merge into zellij's `config.kdl`; the tmux bindings are generated with the session config.
 */
export function keysCommand(zellij: boolean): string {
  const leader = leaderKey();

  if (zellij) return zellijKeybinds(selfCommand(), leader).trimEnd();

  const table = allBindings().map(([action, keys]) => `  ${keys.map((k) => (k === " " ? "space" : k)).join(", ").padEnd(18)} ${action}`);

  return [
    "shared list keys:",
    ...table,
    "",
    `leader chord: ${zellijKey(leader)} (tmux ${tmuxKey(leader)}), then a top panel button key: ${PRESS_KEYS.join(" ")}`,
    "set `[keys] leader` in repos.toml to change it; `overbridge keys --zellij` prints the zellij keybinds",
  ].join("\n");
}
