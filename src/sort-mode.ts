import { naturalSort } from "./util";

/** How a list is ordered. Every mode ends in the name, so the order never changes between two draws. */
export const SORT_MODES = ["alpha", "status", "age"] as const;

export type SortMode = (typeof SORT_MODES)[number];

/** The mode after `mode`, wrapping. */
export const nextSort = (mode: SortMode): SortMode => SORT_MODES[(SORT_MODES.indexOf(mode) + 1) % SORT_MODES.length] ?? SORT_MODES[0];

/** What the mode is called on screen. */
export const SORT_LABEL: Record<SortMode, string> = { alpha: "a-z", status: "by status", age: "by age" };

/** Something orderable: its name breaks every tie, `rank` is its status (low first) and `since` its start time in ms (old first; none last). */
export interface Sortable {
  name: string;
  rank: number;
  since: number | undefined;
}

/** The comparison for `mode`. Equal on the mode's key falls through to the name, then the original index never matters. */
export function compareFor(mode: SortMode): (a: Sortable, b: Sortable) => number {
  const byName = (a: Sortable, b: Sortable) => naturalSort(a.name, b.name);

  if (mode === "status") return (a, b) => a.rank - b.rank || byName(a, b);

  if (mode === "age") return (a, b) => (a.since ?? Infinity) - (b.since ?? Infinity) || byName(a, b);

  return byName;
}

/** `items` ordered by `mode`; `describe` reads an item's sort keys. The input is not changed. */
export function sortBy<T>(items: readonly T[], mode: SortMode, describe: (item: T) => Sortable): T[] {
  const compare = compareFor(mode);

  return items.toSorted((a, b) => compare(describe(a), describe(b)));
}
