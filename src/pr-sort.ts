import { HEALTH_LOOK, healthOf } from "./pr-look";
import type { PrRow } from "./pr-rows";
import { type SortMode, sortBy } from "./sort-mode";

/** The PR rows ordered by `mode`: repo and number, how much each needs (conflicts first), or the longest-waiting first. Ties fall back to the name, so a refresh never reshuffles. */
export const sortPrRows = (rows: readonly PrRow[], mode: SortMode): PrRow[] =>
  sortBy(rows, mode, (r) => {
    const since = Date.parse(r.updatedAt);

    return { name: `${r.repo}#${r.number}`, rank: HEALTH_LOOK[healthOf(r)].rank, since: Number.isFinite(since) ? since : undefined };
  });
