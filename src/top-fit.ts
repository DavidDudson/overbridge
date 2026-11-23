import { PaneResize } from "./mux";

/** What the top pane has learnt about fitting its height to its buttons. */
export interface FitState {
  /** The height the last fit settled on. While the needed height stays the same, a resize is the user's and is left alone. */
  settled?: number;
  /** How many rows one multiplexer step moved, learnt from the last step that changed the height. */
  stepRows?: number;
  /** A needed height at which a step changed nothing (the tab has no room left): no more steps until it changes. */
  stuck?: number;
}

/**
 * The next step that brings a pane of `rows` rows to `needed`: grow while it is short, shrink while one known step
 * still leaves it tall enough, else none. Never acts on a height it already settled on or got stuck at.
 */
export function planFit(rows: number, needed: number, state: FitState): PaneResize | undefined {
  if (state.settled === needed || state.stuck === needed) {
    return undefined;
  }

  if (rows < needed) {
    return PaneResize.Grow;
  }

  if (rows > needed && state.stepRows !== undefined && rows - state.stepRows >= needed) {
    return PaneResize.Shrink;
  }

  return undefined;
}

/** The state after a step at `needed` took the pane from `before` to `after` rows. */
export function afterStep(state: FitState, before: number, after: number, needed: number): FitState {
  return after === before ? { ...state, stuck: needed } : { ...state, stepRows: Math.abs(after - before) };
}

/** The state once no step is left to take at `needed`. */
export const settle = (state: FitState, needed: number): FitState => ({ ...state, settled: needed });
