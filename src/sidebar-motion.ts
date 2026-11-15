import { GLYPHS } from "./agent-state";
import type { Entry } from "./sidebar";

/** `[sidebar] motion` in repos.toml: `off` keeps every glyph still, `while-active` animates a card only while its agent works. */
export const Motion = { Off: "off", WhileActive: "while-active" } as const;
export type Motion = (typeof Motion)[keyof typeof Motion];

/** A quarter turn of a clock hand per frame; every frame is two columns wide like the static glyph, so no card reflows. */
export const BUSY_FRAMES = ["🕛", "🕒", "🕕", "🕘"] as const;

/** Milliseconds each frame shows. The sidebar polls once a second, so this is also the fastest a frame can change. */
export const FRAME_MS = 1_000;

/** The busy frame showing at `now`: a pure function of the clock, so it costs no I/O and no timer. */
export const busyFrame = (now: number): string => BUSY_FRAMES[Math.floor(now / FRAME_MS) % BUSY_FRAMES.length]!;

/** `list` with each busy card's glyph set to its frame at `now`. Other states, and `Motion.Off`, come back unchanged (same array). */
export function animate(list: Entry[], now: number, motion: Motion): Entry[] {
  if (motion === Motion.Off || !list.some((e) => e.state === "busy" && !e.fault && e.glyph === GLYPHS.busy)) return list;
  const frame = busyFrame(now);
  return list.map((e) => (e.state === "busy" && !e.fault && e.glyph === GLYPHS.busy ? { ...e, glyph: frame } : e));
}
