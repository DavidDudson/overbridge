import { alternate } from "./anim";
import { HEALTH_LOOK, healthOf, type HealthInput } from "./pr-look";
import { textWidth, type Color } from "./term";

/** One row's icon in a badge. `rank` orders the icons, lowest first; an `alt` unlike `icon` pulses between the two. */
export interface BadgeIcon {
  icon: string;
  alt: string;
  color: Color;
  rank: number;
}

/**
 * What a sidebar entry shows for an orchestration tab that lists things: how many, and one icon per row for what it
 * needs, worst first. Any tab feeds it plain `BadgeIcon`s, so the sidebar knows nothing of the tab's data.
 */
export interface TabBadge {
  count: number;
  icons: BadgeIcon[];
  /** The clock the sidebar animates this badge at (`animate`); unset draws it still. */
  at?: number;
}

/** Whether `i` pulses between two glyphs when the badge animates. */
export const pulsesIcon = (i: BadgeIcon): boolean => i.alt !== i.icon;

export function badgeFromIcons(icons: readonly BadgeIcon[]): TabBadge {
  return { count: icons.length, icons: icons.toSorted((a, b) => a.rank - b.rank) };
}

/** The badge of a list of PR-shaped rows, one health icon each. */
export const badgeOf = (rows: readonly HealthInput[]): TabBadge => badgeFromIcons(rows.map((r) => HEALTH_LOOK[healthOf(r)]));

/** The entry's title with its count: `reviews 5`, or the bare label when nothing is listed. */
export const badgeLabel = (label: string, b: TabBadge): string => (b.count > 0 ? `${label} ${b.count}` : label);

/** Colour of the whole status line: the worst icon's, grey when nothing is listed. */
export const badgeColor = (b: TabBadge): Color => b.icons[0]?.color ?? "grey";

/**
 * The icons as a status line fitted to `width` columns; what does not fit becomes `+N`. A pulsing icon alternates
 * between two glyphs of the same width when `animated`, so the card never reflows.
 */
export function badgeText(b: TabBadge, width: number, nowMs = b.at ?? 0, animated = b.at !== undefined): string {
  if (b.count === 0) return "nothing waiting";
  const glyphs = b.icons.map((i) => (animated && pulsesIcon(i) ? alternate(i.icon, i.alt, nowMs) : i.icon));
  let out = "";

  for (const [i, g] of glyphs.entries()) {
    const more = glyphs.length - i - 1;
    const reserve = more > 0 ? textWidth(` +${more}`) : 0;

    if (textWidth(out + g) + reserve > width) return `${out} +${glyphs.length - i}`.trimStart();
    out += g;
  }

  return out;
}
