import { PaneResize } from "./mux";

/** What the top pane has learnt about fitting its height to its buttons. */
export interface FitState {
  /** The height the last fit settled on. While the needed height stays the same, a resize is the user's and is left alone. */
  settledRows?: number;
  /** How many rows one multiplexer step moved, learnt from the last step that changed the height. */
  stepRows?: number;
  /** A needed height at which a step changed nothing (the tab has no room left): no more steps until it changes. */
  stuckRows?: number;
}

/** The next resize toward `needed`; with no step size known, one shrink learns it, and an overshoot grows back. */
export function planFit(rows: number, needed: number, state: FitState): PaneResize | undefined {
  if (state.settledRows === needed || state.stuckRows === needed) {
    return undefined;
  }

  if (rows < needed) {
    return PaneResize.Grow;
  }

  if (rows > needed && (state.stepRows === undefined || rows - state.stepRows >= needed)) {
    return PaneResize.Shrink;
  }

  return undefined;
}

/** The state after a step at `needed` took the pane from `before` to `after` rows. */
export function afterStep(state: FitState, before: number, after: number, needed: number): FitState {
  return after === before ? { ...state, stuckRows: needed } : { ...state, stepRows: Math.abs(after - before), stuckRows: undefined };
}

/** The state once no step is left to take at `needed`. */
export const settle = (state: FitState, needed: number): FitState => ({ ...state, settledRows: needed, stuckRows: state.stuckRows === needed ? needed : undefined });
