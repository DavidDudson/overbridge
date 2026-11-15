import { cachedRead } from "./gauge";
import { prListPath, type PrListCache, type PrListKind } from "./prlist-run";
import type { PrRow } from "./pr-rows";
import { badgeOf, type TabBadge } from "./tab-badge";

/** The PR list behind each orchestration tab that shows a badge. A tab not here has none. */
const BADGE_LISTS: Record<string, PrListKind> = { "@reviews": "reviews" };

/** The badge of orchestration tab `tab`, read from its list cache (re-read only when the file changed). */
export function readBadge(tab: string): TabBadge | undefined {
  const kind = BADGE_LISTS[tab];

  return kind ? cachedRead<TabBadge>(prListPath(kind), (raw) => ((raw as PrListCache).rows ? badgeOf((raw as PrListCache).rows as PrRow[]) : undefined)) : undefined;
}
