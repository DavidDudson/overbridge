import { GLYPHS } from "./agent-state";
import type { Motion } from "./config";
import { Motion as Modes } from "./config";
import type { Entry } from "./sidebar";

/** A quarter turn of a clock hand per frame; every frame is two columns wide like the static glyph, so no card reflows. */
export const BUSY_FRAMES = ["🕛", "🕒", "🕕", "🕘"] as const;

/** Milliseconds each frame shows. A frame cannot change faster than the sidebar redraws. */
export const FRAME_MS = 1_000;

/** The busy frame showing at `nowMs`: a pure function of the clock, so it costs no I/O and no timer. */
export const busyFrame = (nowMs: number): string => BUSY_FRAMES[Math.floor(nowMs / FRAME_MS) % BUSY_FRAMES.length] ?? BUSY_FRAMES[0];

/** A card that is working and shows the static busy glyph; a faulted card or one with another glyph stays as it is. */
const isBusyCard = (e: Entry): boolean => e.state === "busy" && !e.fault && e.glyph === GLYPHS.busy;

/** `list` with each busy card's glyph set to its frame at `nowMs`. With `Motion.Off`, or nothing busy, the same array comes back. */
export function animate(list: Entry[], nowMs: number, motion: Motion): Entry[] {
  if (motion === Modes.Off || !list.some(isBusyCard)) return list;
  const frame = busyFrame(nowMs);
  return list.map((e) => (isBusyCard(e) ? { ...e, glyph: frame } : e));
}
