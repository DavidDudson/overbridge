import { cachedRead } from "./gauge";
import { prsBadge, workBadge } from "./my-badges";
import { prListPath, type PrListCache } from "./prlist-run";
import type { PrRow } from "./pr-rows";
import { badgeOf, type TabBadge } from "./tab-badge";

/** The badge of orchestration tab `tab`, read from its list cache (re-read only when the file changed). A tab not listed has none. */
export function readBadge(tab: string): TabBadge | undefined {
  switch (tab) {
    case "@reviews":
      return cachedRead<TabBadge>(prListPath("reviews"), (raw) => ((raw as PrListCache).rows ? badgeOf((raw as PrListCache).rows as PrRow[]) : undefined));
    case "@prs":
      return prsBadge();
    case "@work":
      return workBadge();
    default:
      return undefined;
  }
}
