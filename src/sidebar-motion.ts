import { GLYPHS } from "./agent-state";
import type { Motion } from "./config";
import { Motion as Modes } from "./config";
import { pulseGlyph, pulses } from "./card-look";
import type { Entry } from "./sidebar";

/** A quarter turn of a clock hand per frame; every frame is two columns wide like the static glyph, so no card reflows. */
export const BUSY_FRAMES = ["🕛", "🕒", "🕕", "🕘"] as const;

/** Milliseconds each frame shows. A frame cannot change faster than the sidebar redraws. */
export const FRAME_MS = 1_000;

/** The busy frame showing at `nowMs`: a pure function of the clock, so it costs no I/O and no timer. */
export const busyFrame = (nowMs: number): string => BUSY_FRAMES[Math.floor(nowMs / FRAME_MS) % BUSY_FRAMES.length] ?? BUSY_FRAMES[0];

/** A card that is working and shows the static busy glyph; a faulted card or one with another glyph stays as it is. */
const isBusyCard = (e: Entry): boolean => e.state === "busy" && !e.fault && e.glyph === GLYPHS.busy;

/** A card whose badge has a merge conflict, which pulses. */
const hasConflict = (e: Entry): boolean => !e.fault && (e.badge?.icons.includes("conflict") ?? false);

/** A card with a claimed PR in conflict: its chip pulses. */
const prConflicts = (e: Entry): boolean => e.prs?.some((p) => p.status === "conflict") ?? false;

/** A card whose glyph pulses: one that wants input, runs background work, or ended with unsaved work. */
const isPulsing = (e: Entry): boolean => !e.fault && pulses(e.state, e.glyph, Boolean(e.unsaved));

const moves = (e: Entry): boolean => isBusyCard(e) || hasConflict(e) || prConflicts(e) || isPulsing(e);

/**
 * `list` with each busy card's glyph set to its frame at `nowMs`, each waiting, background or unsaved card's glyph
 * pulsing, and each badge or PR chip with a conflict stamped with the clock so it pulses. With `Motion.Off`, or nothing
 * moving, the same array comes back.
 */
export function animate(list: Entry[], nowMs: number, motion: Motion): Entry[] {
  if (motion === Modes.Off || !list.some(moves)) return list;
  const frame = busyFrame(nowMs);

  return list.map((e) => {
    if (isBusyCard(e)) return prConflicts(e) ? { ...e, glyph: frame, at: nowMs } : { ...e, glyph: frame };

    if (hasConflict(e)) return { ...e, badge: { ...e.badge!, at: nowMs } };

    if (isPulsing(e)) return { ...e, glyph: pulseGlyph(e.state, e.glyph, Boolean(e.unsaved), nowMs), at: nowMs };

    return prConflicts(e) ? { ...e, at: nowMs } : e;
  });
}
