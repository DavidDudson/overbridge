import { agentDirOf } from "./layout";
import { defaultMux, type Mux, type MuxPane } from "./mux";
import { findPane, paneTitle } from "./panes";
import { selfCommand } from "./paths";

/** After opening a Claude pane, leave the multiplexer this long to list it before another is opened. */
export const REOPEN_COOLDOWN_MS = 10_000;

export interface AgentKeepDeps {
  mux?: Pick<Mux, "listPanes" | "newPane" | "closePane">;
  self?: string[];
  now?: () => number;
  /** Where the agent starts; the workspace's agent folder by default. */
  cwd?: (ws: string) => string;
}

const lastOpenedMs = new Map<string, number>();

/** Forget the cooldowns; tests only. */
export const resetAgentKeep = () => lastOpenedMs.clear();

/** Where a replacement Claude opens: left of the diff (or terminal) pane, which hold the right-hand column, else under the top panel. */
export function placement(panes: MuxPane[], ws: string): { anchor: string; direction: "left" | "down" } | undefined {
  const beside = findPane(panes, ws, "diff") ?? findPane(panes, ws, "terminal");

  if (beside) return { anchor: beside.id, direction: "left" };
  const top = panes.find((p) => !p.exited && p.tab === ws && p.title === "top");

  return top ? { anchor: top.id, direction: "down" } : undefined;
}

/**
 * Bring Claude back into `ws`'s tab when its pane was closed (or its command exited and the pane was left behind).
 * The supervisor restarts an agent that exits inside a pane; this covers the pane itself going away. It does
 * nothing unless the tab is listed (its sidebar pane is there), so a failed multiplexer query never opens panes.
 * Returns whether it opened one. The caller decides when it is safe: not for a workspace the user exited on purpose.
 */
export function ensureAgentPane(ws: string, deps: AgentKeepDeps = {}): boolean {
  const mux = deps.mux ?? defaultMux();
  const now = (deps.now ?? Date.now)();
  const panes = mux.listPanes();

  if (!panes.some((p) => p.tab === ws && p.title === "sidebar")) return false;

  if (findPane(panes, ws, "claude")) return false;

  if (now - (lastOpenedMs.get(ws) ?? -Infinity) < REOPEN_COOLDOWN_MS) return false;

  // a command pane that exited stays behind in zellij; clear it so the tab does not collect corpses
  panes.filter((p) => p.exited && p.tab === ws && p.title === paneTitle(ws, "claude")).forEach((p) => mux.closePane(p.id));

  const where = placement(panes, ws);

  if (!where) return false;
  const self = deps.self ?? selfCommand();

  const opened = mux.newPane({
    ...where,
    title: paneTitle(ws, "claude"),
    cwd: (deps.cwd ?? agentDirOf)(ws),
    command: [...self, "claude", ws, "--", "--continue"],
    closeOnExit: false,
  });

  if (opened) lastOpenedMs.set(ws, now);

  return opened;
}
