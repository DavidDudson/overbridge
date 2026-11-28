import { defaultMux, type Mux } from "./mux";
import { findPane } from "./panes";
import { boxBottom, boxSide, boxTop } from "./term";
import type { FrameSide } from "./frame";
import type { PaneKind } from "./top";

/**
 * What a frame edge shows, as rows of a `width` x `height` pane: the top edge is the title border with both rounded
 * corners, the bottom edge its closing border, and a side is a column of `│`. Matches the Workspaces frame.
 */
export function edgeRows(side: FrameSide, title: string, width: number, height: number): string[] {
  if (side === "top") return [boxTop(title, width)];

  if (side === "bottom") return [boxBottom(width)];

  return Array.from({ length: Math.max(1, height) }, boxSide);
}

/** The screen text for one repaint: each row placed by cursor position, so the last row never scrolls the pane. */
export const paint = (rows: string[]): string => `\x1b[H\x1b[2J${rows.map((r, i) => `\x1b[${i + 1};1H${r}`).join("")}`;

/** Polls that find the framed pane missing before an edge exits, and the grace after it starts (the pane's title lands late). */
const GONE_POLLS = 3;
const POLL_MS = 1_000;
const GRACE_MS = 10_000;

/**
 * `overbridge frame-edge --side S --ws W --kind K [--title T]`: one side of the frame around the `K` pane of tab `W`.
 * Redraws on resize and exits once that pane has been gone for a few polls, so closing the pane takes its frame with
 * it. Reads no input and asks for no mouse, so every click goes to the multiplexer.
 */
export async function frameEdge(side: FrameSide, ws: string, kind: PaneKind, title: string, mux: Mux = defaultMux()) {
  const draw = () => process.stdout.write(paint(edgeRows(side, title, process.stdout.columns ?? 80, process.stdout.rows ?? 24)));
  const started = Date.now();
  let gone = 0;

  process.stdout.write("\x1b[?25l");
  process.on("SIGWINCH", draw);
  process.on("SIGTERM", () => process.exit(0));
  draw();

  for (;;) {
    await Bun.sleep(POLL_MS);
    draw();
    const panes = mux.listPanes();

    // an empty listing means the multiplexer could not answer, which says nothing about the pane
    if (!panes.length || Date.now() - started < GRACE_MS) continue;
    gone = findPane(panes, ws, kind) ? 0 : gone + 1;

    if (gone >= GONE_POLLS) break;
  }

  process.stdout.write("\x1b[?25h");
}
