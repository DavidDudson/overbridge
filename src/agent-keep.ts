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
  cwd?: (ws: string) => string;
}

const lastOpenedMs = new Map<string, number>();

export const resetAgentKeep = () => lastOpenedMs.clear();

/** Where a replacement Claude opens: left of the diff (or terminal) pane, which hold the right-hand column, else under the top panel. */
export function placement(panes: MuxPane[], ws: string): { anchor: string; direction: "left" | "down" } | undefined {
  const beside = findPane(panes, ws, "diff") ?? findPane(panes, ws, "terminal");

  if (beside) return { anchor: beside.id, direction: "left" };
  const top = panes.find((p) => !p.exited && p.tab === ws && p.title === "top");

  return top ? { anchor: top.id, direction: "down" } : undefined;
}

/**
 * Bring Claude back into `ws`'s tab when its pane was closed or left behind exited. Does nothing unless the tab's
 * sidebar pane is listed, so a failed multiplexer query never opens panes. The caller decides when it is safe.
 * With `prompt` the new Claude starts a fresh conversation on it instead of continuing one.
 */
export function ensureAgentPane(ws: string, deps: AgentKeepDeps = {}, prompt?: string): boolean {
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
  // a refused open is not retried until the cooldown ends either, since opening focuses the anchor pane
  lastOpenedMs.set(ws, now);
  const self = deps.self ?? selfCommand();

  return mux.newPane({
    ...where,
    title: paneTitle(ws, "claude"),
    cwd: (deps.cwd ?? agentDirOf)(ws),
    // a pane that never came up has no conversation to continue, so it starts fresh on the prompt it lost
    command: prompt ? [...self, "claude", ws, "--", prompt] : [...self, "claude", ws, "--", "--continue"],
    closeOnExit: false,
  });
}
