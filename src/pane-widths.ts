/**
 * The tab layout's widths, as a pure plan: the sidebar holds `SIDEBAR_PERCENT` of the window and the rest is split
 * evenly between the Claude pane and the diff pane beside it. tmux keeps pane sizes proportional on a resize and hands a
 * closed or opened pane's space to one neighbour, so the layout drifts; `planWidths` says what to set to bring it back.
 */
export const SIDEBAR_PERCENT = 25;

/** One pane as the multiplexer reports it, with the width of the window it sits in. */
export interface PaneBox {
  id: string;
  window: string;
  windowWidth: number;
  title: string;
  left: number;
  width: number;
}

/** Set pane `id` to `width` columns. */
export interface WidthStep {
  id: string;
  width: number;
}

const SIDEBAR_TITLE = "sidebar";

const isKind = (p: PaneBox, kind: "claude" | "diff") => p.title.endsWith(` · ${kind}`);

/** The sidebar's columns in a window `windowWidth` wide: the same share tmux's `-l 25%` gives. */
export const sidebarWidth = (windowWidth: number) => Math.floor((windowWidth * SIDEBAR_PERCENT) / 100);

/**
 * The resizes that fix each window's widths, in the order to apply them (the sidebar first, so Claude's share is
 * measured in what is left). A window with no sidebar is left alone; one with no diff beside Claude gets the sidebar only.
 * A step is left out when the pane already has that width.
 */
export function planWidths(panes: PaneBox[]): WidthStep[] {
  const steps: WidthStep[] = [];
  const windows = new Map<string, PaneBox[]>();

  for (const p of panes) windows.set(p.window, [...(windows.get(p.window) ?? []), p]);

  for (const group of windows.values()) {
    const sidebar = group.find((p) => p.title === SIDEBAR_TITLE && p.left === 0);

    if (!sidebar) continue;
    const total = sidebar.windowWidth;
    const side = sidebarWidth(total);

    if (sidebar.width !== side) steps.push({ id: sidebar.id, width: side });
    const claude = group.find((p) => isKind(p, "claude"));
    const diff = group.find((p) => isKind(p, "diff"));

    if (!claude || !diff || diff.left <= claude.left) continue;
    // a border cell sits after the sidebar and another between Claude and the diff; Claude takes the smaller half
    const content = total - side - 2;
    const want = Math.floor(content / 2);

    if (claude.width !== want || diff.width !== content - want) steps.push({ id: claude.id, width: want });
  }

  return steps;
}
