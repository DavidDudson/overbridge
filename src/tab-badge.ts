import { alternate } from "./anim";
import { HEALTH_LOOK, healthOf, type HealthInput, type PrHealth } from "./pr-look";
import { textWidth, type Color } from "./term";

/**
 * What a sidebar entry shows for a tab that lists PRs: how many, and one icon per PR for what it needs,
 * worst first. Any tab feeds it plain `HealthInput`s, so the sidebar knows nothing of the tab's data.
 */
export interface TabBadge {
  count: number;
  icons: PrHealth[];
}

export function badgeOf(rows: readonly HealthInput[]): TabBadge {
  return { count: rows.length, icons: rows.map(healthOf).toSorted((a, b) => HEALTH_LOOK[a].rank - HEALTH_LOOK[b].rank) };
}

/** The entry's title with its count: `reviews 5`, or the bare label when nothing is listed. */
export const badgeLabel = (label: string, b: TabBadge): string => (b.count > 0 ? `${label} ${b.count}` : label);

/** Colour of the whole status line: the worst icon's, green when nothing needs attention. */
export const badgeColor = (b: TabBadge): Color => (b.icons[0] ? HEALTH_LOOK[b.icons[0]].color : "grey");

/**
 * The icons as a status line fitted to `width` columns; what does not fit becomes `+N`. A conflict pulses between
 * two glyphs of the same width when `animated`, so the card never reflows.
 */
export function badgeText(b: TabBadge, width: number, nowMs = 0, animated = false): string {
  if (b.count === 0) return "nothing waiting";
  const glyphs = b.icons.map((h) => (h === "conflict" && animated ? alternate(HEALTH_LOOK[h].icon, HEALTH_LOOK[h].alt, nowMs) : HEALTH_LOOK[h].icon));
  let out = "";

  for (const [i, g] of glyphs.entries()) {
    const more = glyphs.length - i - 1;
    const reserve = more > 0 ? textWidth(` +${more}`) : 0;

    if (textWidth(out + g) + reserve > width) return `${out} +${glyphs.length - i}`.trimStart();
    out += g;
  }

  return out;
}
