import { defaultMux, type Mux, type MuxPane } from "./mux";
import { findPane } from "./pane-title";
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

/**
 * Polls that find the framed pane missing before an edge exits, and the grace after it starts (the pane's title lands
 * late). Each edge polls the multiplexer and a workspace has eight, so the interval is long: a closed pane's frame
 * lingers a few seconds at most.
 */
const GONE_POLLS = 3;
const POLL_MS = 5_000;
const GRACE_MS = 10_000;

/**
 * The count of polls that have missed the framed pane after one more poll: unchanged while the multiplexer gave no
 * answer (an empty listing) or the edge is still within its grace, reset when the pane is there, else one higher.
 * A pane with the title but not the `pinned` id is a replacement the frame does not surround, so it counts as
 * missing. An edge exits at `GONE_POLLS`.
 */
export function missedPolls(missed: number, panes: MuxPane[], ws: string, kind: PaneKind, sinceStartMs: number, pinned?: string): number {
  if (!panes.length || sinceStartMs < GRACE_MS) return missed;
  const pane = findPane(panes, ws, kind);

  return pane && (pinned === undefined || pane.id === pinned) ? 0 : missed + 1;
}

export const edgeIsGone = (missed: number) => missed >= GONE_POLLS;

/**
 * `overbridge frame-edge --side S --ws W --kind K [--title T]`: one side of the frame around the `K` pane of tab `W`.
 * Redraws on resize and exits once that pane (the one it first found, by id) has been gone for a few polls, so closing
 * the pane takes its frame with it. Reads no input and asks for no mouse, so every click goes to the multiplexer.
 */
export async function frameEdge(side: FrameSide, ws: string, kind: PaneKind, title: string, mux: Mux = defaultMux()) {
  const draw = () => process.stdout.write(paint(edgeRows(side, title, process.stdout.columns ?? 80, process.stdout.rows ?? 24)));
  const started = Date.now();
  let gone = 0;
  let pinned: string | undefined;

  const leave = () => {
    process.stdout.write("\x1b[?25h");
    process.exit(0);
  };

  process.stdout.write("\x1b[?25l");
  process.on("SIGWINCH", draw);
  process.on("SIGTERM", leave);
  process.on("SIGINT", leave);
  draw();

  for (;;) {
    await Bun.sleep(POLL_MS);
    const panes = mux.listPanes();
    pinned ??= findPane(panes, ws, kind)?.id;
    gone = missedPolls(gone, panes, ws, kind, Date.now() - started, pinned);

    if (edgeIsGone(gone)) break;
  }

  leave();
}
