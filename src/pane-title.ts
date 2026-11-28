import type { MuxPane } from "./mux";
import type { PaneKind } from "./top";

// Split from `panes.ts` so a long-lived frame edge finds its pane without loading the git, config and diff code that module imports.

export const paneTitle = (ws: string, kind: PaneKind) => `${ws} · ${kind}`;

/** The live pane of `kind` in `ws`'s tab, if any. */
export function findPane(panes: MuxPane[], ws: string, kind: PaneKind): MuxPane | undefined {
  return panes.find((p) => !p.exited && p.tab === ws && p.title === paneTitle(ws, kind));
}
