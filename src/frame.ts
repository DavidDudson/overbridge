import type { PaneSpec } from "./layout";

// Pure constants of the pane frame, apart from `frame-edge.ts` so the layout can import them without loading the panes.

/** The four sides of the rounded frame drawn around a pane, one thin pane each. */
export const FRAME_SIDES = ["top", "bottom", "left", "right"] as const;

export type FrameSide = (typeof FRAME_SIDES)[number];

export const isFrameSide = (s: string): s is FrameSide => (FRAME_SIDES as readonly string[]).includes(s);

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

export const frameEdges = (p: PaneSpec): Record<FrameSide, PaneSpec> =>
  Object.fromEntries(FRAME_SIDES.map((side) => [side, frameEdgeSpec(p, side)])) as Record<FrameSide, PaneSpec>;
