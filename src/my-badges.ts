import { cachedRead } from "./gauge";
import { rank, type WorkRow } from "./pm/worklist";
import type { CiState, HealthInput } from "./pr-look";
import { prListPath, type PrListKind } from "./prlist-run";
import { badgeOf, type TabBadge } from "./tab-badge";
import { isRecord, isString, type Json } from "./util";
import { worklistPath } from "./worklist-data";
import { workInput } from "./worklist-look";

/**
 * The sidebar badges for the PR list tabs and `@work`, read from the caches their panes keep. `cachedRead` re-parses
 * a file only when it changed and keys on the parser's identity, so every parser here is a module-level function.
 */

const CI_STATES: readonly string[] = ["success", "failure", "pending", "none"];

/** One cached PR row as the fields a badge reads; anything the cache holds that is not a row is skipped. */
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

/** A PR list cache file as its badge; undefined when it holds no `rows`. */
function prBadgeFromCache(raw: Json): TabBadge | undefined {
  return isRecord(raw) && Array.isArray(raw.rows) ? badgeOf(raw.rows.flatMap(healthInput)) : undefined;
}

/** The badge of a PR list tab (`prs` or `reviews`). */
export const prListBadge = (kind: PrListKind): TabBadge | undefined => cachedRead(prListPath(kind), prBadgeFromCache);

const STATUSES: readonly string[] = ["todo", "in-progress", "blocked", "done"];

/** A cached work row with the fields `rank` reads. */
const isWorkRow = (v: unknown): v is WorkRow =>
  isRecord(v) && isString(v.repo) && isString(v.id) && isString(v.status) && STATUSES.includes(v.status) && Array.isArray(v.blockedBy) && Array.isArray(v.labels);

/** The work list cache as its badge: open items only, since a done item needs nothing. */
function workBadgeFromCache(raw: Json): TabBadge | undefined {
  return isRecord(raw) && Array.isArray(raw.rows) ? badgeOf(rank(raw.rows.filter(isWorkRow)).filter((r) => r.status !== "done").map(workInput)) : undefined;
}

export const workBadge = (): TabBadge | undefined => cachedRead(worklistPath(), workBadgeFromCache);
