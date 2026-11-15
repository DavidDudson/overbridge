import { cachedRead } from "./gauge";
import { rank } from "./pm/worklist";
import { prListPath, type PrListCache } from "./prlist-run";
import { badgeOf, type TabBadge } from "./tab-badge";
import type { WorklistCache } from "./worklist-data";
import { worklistPath } from "./worklist-data";
import { workInput } from "./worklist-look";

/**
 * The sidebar badges for the `@prs` and `@work` tabs, read from the caches their panes keep. They go through
 * `cachedRead`, so the sidebar's poll re-parses a file only when it changed. Plain `TabBadge`s, so the sidebar
 * needs no knowledge of either list.
 */

export const prsBadge = (): TabBadge | undefined => cachedRead<TabBadge>(prListPath("prs"), (raw) => ((raw as PrListCache).rows ? badgeOf((raw as PrListCache).rows) : undefined));

/** Open items only: a done item needs nothing, so it is not counted. */
export const workBadge = (): TabBadge | undefined =>
  cachedRead<TabBadge>(worklistPath(), (raw) => ((raw as WorklistCache).rows ? badgeOf(rank((raw as WorklistCache).rows).filter((r) => r.status !== "done").map(workInput)) : undefined));
