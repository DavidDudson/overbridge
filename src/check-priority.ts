import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isNumber, isRecord } from "./util";

/**
 * Check queue priority: each workspace has a class, and queued checks start in class order, then in the order
 * they were queued. The @checks tab can move a waiting check, which writes an explicit sort key for its ticket.
 */

/** Priority classes, highest first. */
export const Priority = { Feature: "feature", Overbridge: "overbridge", Tip: "tip", TechDebt: "tech-debt" } as const;

export type Priority = (typeof Priority)[keyof typeof Priority];

export const PRIORITIES: readonly Priority[] = Object.values(Priority);

export const DEFAULT_PRIORITY: Priority = Priority.Feature;

export const isPriority = (v: unknown): v is Priority => PRIORITIES.some((p) => p === v);

/** Each class's icon on sidebar cards and in the @checks tab; all two columns wide, like the agent glyphs. */
export const PRIORITY_ICON: Record<Priority, string> = {
  [Priority.Feature]: "🚀",
  [Priority.Overbridge]: "🌉",
  [Priority.Tip]: "💡",
  [Priority.TechDebt]: "🧹",
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  [Priority.Feature]: "feature",
  [Priority.Overbridge]: "overbridge",
  [Priority.Tip]: "TIP",
  [Priority.TechDebt]: "tech debt",
};

/** A config rule: the class for a claim whose branch and item id match every pattern the rule sets. */
export interface PriorityRule {
  priority: Priority;
  branch?: string;
  item?: string;
}

/** The repo's priority settings: rules tried in order, then `fallback`. */
export interface PrioritySettings {
  fallback: Priority;
  rules: PriorityRule[];
}

/** What a rule matches against. */
export interface ClaimFacts {
  branch?: string | undefined;
  item?: string | undefined;
}

const matches = (pattern: string | undefined, value: string | undefined) => pattern === undefined || (value !== undefined && new RegExp(pattern).test(value));

/** The class of a claim: the first rule that matches, else the repo's fallback. */
export function priorityOf(settings: PrioritySettings, facts: ClaimFacts): Priority {
  return settings.rules.find((r) => matches(r.branch, facts.branch) && matches(r.item, facts.item))?.priority ?? settings.fallback;
}

/** The highest of `priorities`, or the default when there are none. */
export const highest = (priorities: readonly Priority[]): Priority =>
  priorities.toSorted((a, b) => PRIORITIES.indexOf(a) - PRIORITIES.indexOf(b))[0] ?? DEFAULT_PRIORITY;

/** Wider than any `queuedAtMs`, so a class's keys never overlap the next class's. */
const CLASS_SPAN_MS = 1e14;

/** Sort keys the @checks tab set, by ticket file name. */
export type QueueOrder = Readonly<Record<string, number>>;

/** A ticket's sort key with no override: its class, then when it was queued. */
export const defaultKey = (priority: Priority | undefined, queuedAtMs: number) => PRIORITIES.indexOf(priority ?? DEFAULT_PRIORITY) * CLASS_SPAN_MS + queuedAtMs;

/** Kept beside the tickets; it has no `.json` suffix, so `readTickets` never reads it as one. */
const ORDER_FILE = "order.state";

export const orderPath = (dir: string) => join(dir, ORDER_FILE);

/** The overrides in `dir`; none when the file is missing or unreadable, so a bad file only loses manual moves. */
export function readOrder(dir: string): QueueOrder {
  try {
    const parsed: unknown = JSON.parse(readFileSync(orderPath(dir), "utf8"));

    return isRecord(parsed) ? Object.fromEntries(Object.entries(parsed).filter((e): e is [string, number] => isNumber(e[1]) && Number.isFinite(e[1]))) : {};
  } catch {
    return {};
  }
}

/** Replace the overrides with an atomic rename. Only the @checks tab writes this file. */
export function writeOrder(dir: string, order: QueueOrder) {
  const file = orderPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(order) + "\n");
  renameSync(tmp, file);
}

/** Where a waiting check moves. */
export const Move = { Up: "up", Down: "down", Top: "top", Bottom: "bottom" } as const;

export type Move = (typeof Move)[keyof typeof Move];

/** One waiting check as `moveKey` sees it: its file name and current sort key. */
export interface Keyed {
  name: string;
  key: number;
}

/**
 * The new sort key for `waiting[index]` after `move`, or undefined when it is already there. `waiting` is the
 * waiting checks in queue order; running ones never move, and only the waiting order decides who starts next.
 */
export function moveKey(waiting: readonly Keyed[], index: number, move: Move): number | undefined {
  const keys = waiting.map((w) => w.key);
  const last = keys.length - 1;

  if (index < 0 || index > last) {
    return undefined;
  }

  const between = (lo: number | undefined, hi: number | undefined) => (lo === undefined ? hi! - 1 : hi === undefined ? lo + 1 : (lo + hi) / 2);

  switch (move) {
    case Move.Up:
      return index === 0 ? undefined : between(keys[index - 2], keys[index - 1]);
    case Move.Down:
      return index === last ? undefined : between(keys[index + 1], keys[index + 2]);
    case Move.Top:
      return index === 0 ? undefined : keys[0]! - 1;
    case Move.Bottom:
      return index === last ? undefined : keys[last]! + 1;
  }
}
