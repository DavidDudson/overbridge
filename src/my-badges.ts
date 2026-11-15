import { cachedRead } from "./gauge";
import { rank, type WorkRow, type WorkStatus } from "./pm/worklist";
import type { CiState, HealthInput } from "./pr-look";
import { prListPath, type PrListKind } from "./prlist-run";
import { badgeOf, type TabBadge } from "./tab-badge";
import { isRecord, isString, type Json } from "./util";
import { worklistPath } from "./worklist-data";
import { workInput } from "./worklist-look";

// cachedRead keys on the parser's identity, so every parser here is a module-level function.

const CI_STATES = ["success", "failure", "pending", "none"] as const satisfies readonly CiState[];

const isCiState = (v: Json | undefined): v is CiState => CI_STATES.some((s) => s === v);

/** One cached PR row as the fields a badge reads; anything the cache holds that is not a row is skipped. */
function healthInputs(row: Json): HealthInput[] {
  if (!isRecord(row)) return [];
  const { mergeable, ci, decision } = row;
  const input: HealthInput = { draft: row.draft === true };

  if (isString(mergeable)) input.mergeable = mergeable;

  if (isCiState(ci)) input.ci = ci;

  if (isString(decision)) input.decision = decision;

  return [input];
}

/** A PR list cache file as its badge; undefined when it holds no `rows`. */
export function prBadgeFromCache(raw: Json): TabBadge | undefined {
  return isRecord(raw) && Array.isArray(raw.rows) ? badgeOf(raw.rows.flatMap(healthInputs)) : undefined;
}

/** The badge of a PR list tab (`prs` or `reviews`). */
export const prListBadge = (kind: PrListKind): TabBadge | undefined => cachedRead(prListPath(kind), prBadgeFromCache);

const WORK_STATUSES = ["todo", "in-progress", "blocked", "done"] as const satisfies readonly WorkStatus[];

/** A cached work row: every required `WorkRow` field is present (the rest are optional). */
const isWorkRow = (v: Json): v is Json & WorkRow =>
  isRecord(v) &&
  isString(v.repo) &&
  isString(v.id) &&
  isString(v.title) &&
  isString(v.url) &&
  isString(v.updatedAt) &&
  WORK_STATUSES.some((s) => s === v.status) &&
  Array.isArray(v.blockedBy) &&
  Array.isArray(v.labels);

/** The work list cache as its badge: open items only, since a done item needs nothing. */
export function workBadgeFromCache(raw: Json): TabBadge | undefined {
  return isRecord(raw) && Array.isArray(raw.rows) ? badgeOf(rank(raw.rows.filter(isWorkRow)).filter((r) => r.status !== "done").map(workInput)) : undefined;
}

export const workBadge = (): TabBadge | undefined => cachedRead(worklistPath(), workBadgeFromCache);
