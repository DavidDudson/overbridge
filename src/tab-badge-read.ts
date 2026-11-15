import { cachedRead } from "./gauge";
import { isRecord, isString, type Json } from "./util";
import { prListPath, type PrListKind } from "./prlist-run";
import type { CiState, HealthInput } from "./pr-look";
import { badgeOf, type TabBadge } from "./tab-badge";

const CI_STATES: readonly string[] = ["success", "failure", "pending", "none"];

/** One cached row as the fields a badge reads; anything the cache holds that is not a row is skipped. */
function healthInput(row: Json): HealthInput[] {
  if (!isRecord(row)) return [];
  const { mergeable, ci, decision } = row;
  const input: HealthInput = { draft: row.draft === true };

  if (isString(mergeable)) input.mergeable = mergeable;

  if (isString(ci) && CI_STATES.includes(ci)) {
    // SAFETY: `ci` is one of `CI_STATES`, which are exactly the `CiState` values
    input.ci = ci as CiState;
  }

  if (isString(decision)) input.decision = decision;

  return [input];
}

/** A list cache file as its badge; undefined when it holds no `rows`. A module-level function, so `cachedRead` keeps its result. */
function badgeFromCache(raw: Json): TabBadge | undefined {
  return isRecord(raw) && Array.isArray(raw.rows) ? badgeOf(raw.rows.flatMap(healthInput)) : undefined;
}

/** The PR list behind each orchestration tab that shows a badge. A tab not here has none. */
const BADGE_LISTS = { "@reviews": "reviews" } as const satisfies Record<string, PrListKind>;

/** The badge of orchestration tab `tab`, read from its list cache (re-read only when the file changed). */
export function readBadge(tab: string): TabBadge | undefined {
  if (tab !== "@reviews") return undefined;

  return cachedRead(prListPath(BADGE_LISTS[tab]), badgeFromCache);
}
