import { readFileSync } from "node:fs";
import { join } from "node:path";
import { metaDir } from "./paths";
import { type Color, colorize, dim, fit } from "./term";

/**
 * Claude's usage limits, shown at the foot of the sidebar. Claude's statusline script writes
 * `<meta>/limits.json` (the limits are per account, so any session will do):
 * `{"at": <ms>, "fiveHour": {"pct": 42, "resetsAt": <epoch s>}, "weekly": {...}}`.
 */

export interface Limit {
  pct: number;
  /** Epoch seconds. */
  resetsAt: number;
}
export interface Limits {
  at: number;
  fiveHour?: Limit;
  weekly?: Limit;
}

export const FIVE_HOUR_SECS = 5 * 3600;
export const WEEK_SECS = 7 * 86400;
/** Limits last written longer ago than this are shown as unknown. */
export const LIMITS_STALE_MS = 6 * 3600_000;

export const limitsFile = () => join(metaDir(), "limits.json");

const limit = (raw: unknown): Limit | undefined => {
  const l = raw as Partial<Limit> | undefined;
  return l && typeof l.pct === "number" && typeof l.resetsAt === "number" ? { pct: l.pct, resetsAt: l.resetsAt } : undefined;
};

export function readLimits(path = limitsFile()): Limits | undefined {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const fiveHour = limit(raw.fiveHour);
    const weekly = limit(raw.weekly);
    return { at: typeof raw.at === "number" ? raw.at : 0, ...(fiveHour ? { fiveHour } : {}), ...(weekly ? { weekly } : {}) };
  } catch {
    return undefined;
  }
}

/** "2h10m" or "3d4h". */
export function timeLeft(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return s >= 86400 ? `${Math.floor(s / 86400)}d${Math.floor((s % 86400) / 3600)}h` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

/**
 * Green below 75% projected usage at reset, yellow below 100%, red at or above (or 90% used).
 * Early in a window (under 10% elapsed) the projection is noise, so raw usage stands in.
 */
export function limitColor(l: Limit, windowSecs: number, nowSecs: number): Color {
  const left = Math.min(windowSecs, Math.max(0, l.resetsAt - nowSecs));
  const elapsed = windowSecs - left;
  const projected = elapsed * 10 >= windowSecs ? (l.pct * windowSecs) / elapsed : l.pct;
  if (l.pct >= 90 || projected >= 100) return "red";
  return projected >= 75 ? "yellow" : "green";
}

function row(icon: string, name: string, l: Limit | undefined, windowSecs: number, nowSecs: number, width: number): string {
  if (!l || l.resetsAt <= nowSecs) return dim(fit(`${icon} ${name} –`, width));
  const text = fit(`${icon} ${name} ${l.pct}% ${timeLeft(l.resetsAt - nowSecs)}`, width);
  return colorize(text, limitColor(l, windowSecs, nowSecs));
}

/** The two limit rows, each fitted to `width`. */
export function limitRows(limits: Limits | undefined, width: number, now = Date.now()): string[] {
  const fresh = limits && now - limits.at < LIMITS_STALE_MS ? limits : undefined;
  const secs = now / 1000;
  return [row("⏳", "Hourly", fresh?.fiveHour, FIVE_HOUR_SECS, secs, width), row("📅", "Weekly", fresh?.weekly, WEEK_SECS, secs, width)];
}
