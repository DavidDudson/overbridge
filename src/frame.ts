import type { PaneSpec } from "./layout";
import type { PaneKind } from "./top";

// Pure constants of the pane frame, apart from `frame-edge.ts` so the layout can import them without loading the panes.

/** The four sides of the rounded frame drawn around a pane, one thin pane each. */
export const FRAME_SIDES = ["top", "bottom", "left", "right"] as const;

export type FrameSide = (typeof FRAME_SIDES)[number];

export const isFrameSide = (s: string): s is FrameSide => FRAME_SIDES.some((side) => side === s);

/** The panes a frame can surround: what `PaneKind` names. */
export const PANE_KINDS = ["claude", "terminal", "diff"] as const satisfies readonly PaneKind[];

export const isPaneKind = (s: string): s is PaneKind => PANE_KINDS.some((kind) => kind === s);

/** Rows (top, bottom) or columns (left, right) a frame edge takes. */
export const EDGE_SIZE = 1;

/** Pane `p`'s frame edge on `side`: a pane one row or column thick that draws that side and leaves with `p`. */
export function frameEdgeSpec(p: PaneSpec, side: FrameSide): PaneSpec {
  const { ws, kind, self } = p.frame!;

  return {
    name: `${p.name} · frame ${side}`,
    cwd: p.cwd,
    command: [...self, "frame-edge", "--side", side, "--ws", ws, "--kind", kind, "--title", p.name],
    size: EDGE_SIZE,
    borderless: true,
    closeOnExit: true,
  };
}

// SAFETY: `FRAME_SIDES` lists every `FrameSide`, so the entries cover every key of the record.
export const frameEdges = (p: PaneSpec): Record<FrameSide, PaneSpec> =>
  Object.fromEntries(FRAME_SIDES.map((side) => [side, frameEdgeSpec(p, side)])) as Record<FrameSide, PaneSpec>;
