/** Pure animation frames: each is a function of the clock, so it costs no timer and tests need no fake one. */

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** One braille spinner frame, one column wide, turning every `stepMs`. */
export const spinner = (nowMs: number, stepMs = 100): string => SPINNER_FRAMES[Math.floor(nowMs / stepMs) % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];

/** Alternates true/false every half `periodMs`: the "on" phase of a blink or pulse. */
export const pulse = (nowMs: number, periodMs = 1_000): boolean => Math.floor(nowMs / (periodMs / 2)) % 2 === 0;

/** `a` and `b` taking turns, so a glyph can pulse between two looks of the same width. */
export const alternate = <T>(a: T, b: T, nowMs: number, periodMs = 1_000): T => (pulse(nowMs, periodMs) ? a : b);
