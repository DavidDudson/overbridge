import { cachedRead } from "./gauge";
import { rank } from "./pm/worklist";
import type { CiState, HealthInput } from "./pr-look";
import { prListPath, type PrListKind } from "./prlist-data";
import { type Silenceable, silencedNow } from "./silence";
import { badgeOf, type TabBadge } from "./tab-badge";
import { isRecord, isString, type Json } from "./util";
import { isWorkRow, worklistPath } from "./worklist-data";
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

/** Whether a cached row is silenced now; nothing is silenced by default. */
export type SilencedTest = (row: Silenceable) => boolean;

const noneSilenced: SilencedTest = () => false;

/** A cached row as silence reads it, or undefined when it has no URL. */
function toSilenceable(row: Json): Silenceable | undefined {
  if (!isRecord(row) || !isString(row.url)) return undefined;
  const out: Silenceable = { url: row.url };

  if (row.group === "direct" || row.group === "team") out.group = row.group;

  if (isString(row.seenAt)) out.seenAt = row.seenAt;

  return out;
}

const loud = (silenced: SilencedTest) => (row: Json): boolean => {
  const item = toSilenceable(row);

  return item === undefined || !silenced(item);
};

/** A PR list cache file as its badge, leaving out silenced rows; undefined when it holds no `rows`. */
export function prBadgeFromCache(raw: Json, silenced: SilencedTest = noneSilenced): TabBadge | undefined {
  return isRecord(raw) && Array.isArray(raw.rows) ? badgeOf(raw.rows.filter(loud(silenced)).flatMap(healthInputs)) : undefined;
}

const asJson = (raw: Json): Json => raw;

/** The badge of a PR list tab (`prs` or `reviews`). */
export function prListBadge(kind: PrListKind): TabBadge | undefined {
  const raw = cachedRead(prListPath(kind), asJson);

  return raw === undefined ? undefined : prBadgeFromCache(raw, silencedNow());
}

/** The work list cache as its badge: open items that are not silenced, since a done item needs nothing. */
export function workBadgeFromCache(raw: Json, silenced: SilencedTest = noneSilenced): TabBadge | undefined {
  return isRecord(raw) && Array.isArray(raw.rows) ? badgeOf(rank(raw.rows.filter(isWorkRow)).flatMap((r) => (r.status === "done" || silenced(r) ? [] : [workInput(r)]))) : undefined;
}

export function workBadge(): TabBadge | undefined {
  const raw = cachedRead(worklistPath(), asJson);

  return raw === undefined ? undefined : workBadgeFromCache(raw, silencedNow());
}
