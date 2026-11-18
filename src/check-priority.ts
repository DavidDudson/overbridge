import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, isNumber, isRecord } from "./util";

/** A check queue class from the root `priority-classes`; the list is highest first. */
export interface PriorityClass {
  name: string;
  /** Two columns wide, like the agent glyphs, so card rows stay aligned. */
  icon: string;
  /** The class a claim gets when no rule or repo setting names one; the first class when none is marked. */
  default?: boolean;
}

export const DEFAULT_CLASSES: readonly PriorityClass[] = [
  { name: "high", icon: "🔺" },
  { name: "normal", icon: "🔹", default: true },
  { name: "low", icon: "🔻" },
];

/** A claim's class as tickets and the sidebar carry it: `rank` 0 starts first. */
export interface ClassInfo {
  name: string;
  rank: number;
  icon: string;
}

export const defaultClassName = (classes: readonly PriorityClass[]): string => (classes.find((c) => c.default) ?? classes[0])?.name ?? "";

/** `name`'s place in `classes`; an unknown name gets the default class's. */
export function classInfo(classes: readonly PriorityClass[], name: string): ClassInfo {
  const at = classes.findIndex((c) => c.name === name);
  const rank = at >= 0 ? at : Math.max(0, classes.findIndex((c) => c.name === defaultClassName(classes)));
  const cls = classes[rank];

  return { name: cls?.name ?? name, rank, icon: cls?.icon ?? "" };
}

/** A config rule: the class for a claim whose branch and item id match every pattern the rule sets. */
export interface PriorityRule {
  priority: string;
  branch?: string;
  item?: string;
}

export interface ClaimFacts {
  branch?: string | undefined;
  item?: string | undefined;
}

const matches = (pattern: string | undefined, value: string | undefined) => pattern === undefined || (value !== undefined && new RegExp(pattern).test(value));

/** The class name of a claim: the first matching rule, else `fallback`. */
export const priorityOf = (rules: readonly PriorityRule[], fallback: string, facts: ClaimFacts): string =>
  rules.find((r) => matches(r.branch, facts.branch) && matches(r.item, facts.item))?.priority ?? fallback;

/** The class that starts first among `classes`, or undefined for none. */
export const highest = (classes: readonly ClassInfo[]): ClassInfo | undefined => classes.toSorted((a, b) => a.rank - b.rank)[0];

/** Wider than any `queuedAtMs`, so a class's keys never overlap the next class's. */
const CLASS_SPAN_MS = 1e14;

/** Sort keys the @checks tab set, by ticket file name. */
export type QueueOverrides = Readonly<Record<string, number>>;

export const defaultKey = (rank: number, queuedAtMs: number) => rank * CLASS_SPAN_MS + queuedAtMs;

/** No `.json` suffix, so `readTickets` never reads it as a ticket. */
const OVERRIDES_FILE = "order.state";

export const overridesPath = (dir: string) => join(dir, OVERRIDES_FILE);

const parseOverrides = (text: string): QueueOverrides => {
  const parsed: unknown = JSON.parse(text);

  if (!isRecord(parsed)) {
    throw new Error(`expected a mapping of ticket name to sort key, got ${JSON.stringify(parsed)}`);
  }

  return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, number] => isNumber(e[1]) && Number.isFinite(e[1])));
};

/** The overrides for sorting; none when the file is missing or unreadable, so a bad file only loses manual moves. */
export function readOverrides(dir: string): QueueOverrides {
  try {
    return parseOverrides(readFileSync(overridesPath(dir), "utf8"));
  } catch {
    return {};
  }
}

/** The overrides for a write: none when missing, a throw when unreadable, so a move never overwrites a file it cannot parse. */
export function readOverridesForWrite(dir: string): QueueOverrides {
  const file = overridesPath(dir);
  let text: string;

  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") {
      return {};
    }

    throw e;
  }

  try {
    return parseOverrides(text);
  } catch (e) {
    throw new Error(`${file} is not valid (${errorMessage(e)}); fix or delete it to move checks again`, { cause: e });
  }
}

/** Only the @checks tab writes this file. */
export function writeOverrides(dir: string, overrides: QueueOverrides) {
  const file = overridesPath(dir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(overrides) + "\n");
  renameSync(tmp, file);
}

export const Move = { Up: "up", Down: "down", Top: "top", Bottom: "bottom" } as const;

export type Move = (typeof Move)[keyof typeof Move];

/** Where `index` lands after `move` in a list of `length`, or undefined when it is already there. */
export function movedIndex(length: number, index: number, move: Move): number | undefined {
  const last = length - 1;

  if (index < 0 || index > last) {
    return undefined;
  }

  const target = { [Move.Up]: index - 1, [Move.Down]: index + 1, [Move.Top]: 0, [Move.Bottom]: last }[move];

  return target < 0 || target > last || target === index ? undefined : target;
}

/** `keys` in ascending order with each tie nudged above the key before it, so every check keeps a distinct key. */
export function spreadKeys(keys: readonly number[]): number[] {
  const out: number[] = [];

  for (const k of keys.toSorted((a, b) => a - b)) {
    const prev = out.at(-1);
    out.push(prev !== undefined && k <= prev ? prev + 1 : k);
  }

  return out;
}
