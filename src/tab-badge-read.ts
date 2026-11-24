import { readQueue } from "./check-queue";
import { checksBadge, frozenBadge, prListBadge, workBadge } from "./my-badges";
import type { State } from "./state";
import type { TabBadge } from "./tab-badge";

/** The badge of orchestration tab `tab`, read from its list cache, the check queue or `state`. A tab with no list has none. */
export function readBadge(tab: string, state: State): TabBadge | undefined {
  switch (tab) {
    case "@reviews":
      return prListBadge("reviews");
    case "@prs":
      return prListBadge("prs");
    case "@work":
      return workBadge();
    case "@checks":
      return checksBadge(readQueue());
    case "@frozen":
      return frozenBadge(state);
    default:
      return undefined;
  }
}
