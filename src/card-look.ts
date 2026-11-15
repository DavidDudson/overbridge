import { type AgentState, GLYPHS } from "./agent-state";
import { alternate } from "./anim";
import type { HealthInput } from "./pr-look";
import type { Color } from "./term";
import type { PrStatus } from "./top";

// Pure mapping from a workspace card's facts to how it looks.

const MINUTE_MS = 60_000;

/** Elapsed time and the colour it takes: quiet at first, then yellow, then red once the wait or run is long. */
const TINTS: Partial<Record<AgentState, readonly { from: number; color: Color }[]>> = {
  busy: [
    { from: 10 * MINUTE_MS, color: "yellow" },
    { from: 30 * MINUTE_MS, color: "red" },
  ],
  waiting: [
    { from: 0, color: "yellow" },
    { from: 10 * MINUTE_MS, color: "red" },
  ],
  bg: [{ from: 30 * MINUTE_MS, color: "yellow" }],
  done: [{ from: 60 * MINUTE_MS, color: "grey" }],
};

/** The colour of the elapsed time of a card in `state` after `ms`; undefined keeps the status line's own colour. */
export function timeTint(state: AgentState | undefined, ms: number): Color | undefined {
  const steps = state ? TINTS[state] : undefined;

  return steps?.findLast((s) => ms >= s.from)?.color;
}

/** Glyph pairs of one width a state pulses between: a bell on a wait, an hourglass turning over for background work, a burst on unsaved work. */
const PULSE: Partial<Record<AgentState, readonly [string, string]>> = {
  waiting: [GLYPHS.waiting, "🔔"],
  bg: [GLYPHS.bg, "⌛"],
  end: [GLYPHS.end, "💥"],
};

/** The pair a card in `state` showing `glyph` pulses between; an ended card pulses only with unsaved work. */
function pairFor(state: AgentState | undefined, glyph: string, unsaved: boolean): readonly [string, string] | undefined {
  const pair = state ? PULSE[state] : undefined;

  return pair?.[0] === glyph && (state !== "end" || unsaved) ? pair : undefined;
}

/** Whether a card in `state` showing `glyph` pulses. */
export const pulses = (state: AgentState | undefined, glyph: string, unsaved: boolean): boolean => pairFor(state, glyph, unsaved) !== undefined;

/** The glyph a card shows at `nowMs`: `glyph` itself unless its state pulses. */
export function pulseGlyph(state: AgentState | undefined, glyph: string, unsaved: boolean, nowMs: number): string {
  const pair = pairFor(state, glyph, unsaved);

  return pair ? alternate(pair[0], pair[1], nowMs) : glyph;
}

/** The colour a card's title takes, or `dim` for a card with nothing going on. Undefined leaves a working card plain. */
export function titleTone(state: AgentState | undefined, hasTask: boolean, problem: boolean): Color | "dim" | undefined {
  if (problem) return "red";

  if (state === "waiting") return "yellow";

  if (state === "done") return "green";

  if (state === "bg") return "cyan";

  if (state === "empty" || state === "idle" || (state === undefined && hasTask)) return "dim";

  return undefined;
}

/** A claimed PR's state as the plain input the shared health icons read; none for a PR that is merged, closed or unread, which no chip describes. */
export function prHealthInput(status: PrStatus): HealthInput | undefined {
  switch (status) {
    case "conflict":
      return { draft: false, mergeable: "CONFLICTING" };
    case "failing":
      return { draft: false, ci: "failure" };
    case "pending":
      return { draft: false, ci: "pending" };
    case "blocked":
      return { draft: false, decision: "REVIEW_REQUIRED" };
    case "mergeable":
      return { draft: false, mergeable: "MERGEABLE", ci: "success" };
    default:
      return undefined;
  }
}
