import { badgeOf, type TabBadge } from "./tab-badge";
import { readPrList } from "./prlist-run";
import { workInput } from "./worklist-look";
import { rank } from "./pm/worklist";
import { readWorklist } from "./worklist-data";

/**
 * The sidebar badges for the `@prs` and `@work` tabs, read from the caches their panes keep. Plain `TabBadge`s, so
 * the sidebar needs no knowledge of either list.
 */

export const prsBadge = (): TabBadge => badgeOf(readPrList("prs").rows);

/** Open items only: a done item needs nothing, so it is not counted. */
export const workBadge = (): TabBadge => badgeOf(rank(readWorklist().rows).filter((r) => r.status !== "done").map(workInput));
