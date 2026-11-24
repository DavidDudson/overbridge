import type { QueueView } from "./check-queue";
import { checksBadge } from "./checks";
import { frozenBadge } from "./frozen";
import { prListBadge, workBadge } from "./my-badges";
import type { State } from "./state";
import type { TabBadge } from "./tab-badge";

/** What the badges read besides their own caches. With no `queue`, the @checks card has no badge. */
export interface BadgeSources {
  state: State;
  queue?: QueueView;
}

/** The badge of orchestration tab `tab`. A tab with no list has none. */
export function readBadge(tab: string, { state, queue }: BadgeSources): TabBadge | undefined {
  switch (tab) {
    case "@reviews":
      return prListBadge("reviews");
    case "@prs":
      return prListBadge("prs");
    case "@work":
      return workBadge();
    case "@checks":
      return queue && checksBadge(queue);
    case "@frozen":
      return frozenBadge(state);
    default:
      return undefined;
  }
}
