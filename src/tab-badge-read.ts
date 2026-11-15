import { prListBadge, workBadge } from "./my-badges";
import type { TabBadge } from "./tab-badge";

/** The badge of orchestration tab `tab`, read from its list cache (re-read only when the file changed). A tab not listed has none. */
export function readBadge(tab: string): TabBadge | undefined {
  switch (tab) {
    case "@reviews":
      return prListBadge("reviews");
    case "@prs":
      return prListBadge("prs");
    case "@work":
      return workBadge();
    default:
      return undefined;
  }
}
