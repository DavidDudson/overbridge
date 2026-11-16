import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, isJsonString, type JsonObject, type JsonValue, numberField, objectField, parseJson, stringField } from "./json";
import { metaDir } from "./paths";

/**
 * Silenced list items (#224): a silenced issue or PR stays in its tab, drawn dim, and leaves the sidebar badges.
 * `silenced.json` holds what the user chose, keyed by item URL; only a pane's toggle writes it, so no background
 * writer races the user. `mentions.json` holds the newest comment that mentions the user on each watched item, and
 * only `overbridge silence refresh` writes it. A mention newer than the silence lifts it without a write.
 */

export type SilenceState = "silenced" | "unsilenced";

export interface SilenceEntry {
  state: SilenceState;
  /** ISO time of the toggle; a mention after it lifts a silence. */
  at: string;
}

export type SilenceStore = Map<string, SilenceEntry>;

export interface MentionCache {
  /** When the scan finished (ms); 0 for none. */
  at: number;
  /** Item URL to the ISO time of the newest comment that mentions the user. */
  mentions: Map<string, string>;
  error?: string;
}

/** What silence reads from a row of any tab. */
export interface Silenceable {
  url: string;
  /** Reviews tab: a review asked only of a team starts silenced. */
  group?: "direct" | "team";
  /** Reviews tab: when the row first appeared, which is when a team row's silence starts. */
  seenAt?: string;
}

export const silencePath = () => join(metaDir(), "silenced.json");

export const mentionsPath = () => join(metaDir(), "mentions.json");

const SILENCE_STATES = ["silenced", "unsilenced"] as const satisfies readonly SilenceState[];

const isState = (v: JsonValue | undefined): v is SilenceState => SILENCE_STATES.some((s) => s === v);

/** The store from parsed `silenced.json`; an entry of the wrong shape is skipped, so a hand edit cannot break a pane. */
export function parseStore(raw: JsonValue): SilenceStore {
  const items = isJsonObject(raw) ? objectField(raw, "items") : undefined;
  const store: SilenceStore = new Map();

  for (const [url, v] of Object.entries(items ?? {})) {
    const entry = isJsonObject(v) ? v : undefined;
    const state = entry?.state;
    const at = entry ? stringField(entry, "at") : undefined;

    if (isState(state) && at !== undefined) store.set(url, { state, at });
  }

  return store;
}

/** The mention cache from parsed `mentions.json`. */
export function parseMentions(raw: JsonValue): MentionCache {
  const root = isJsonObject(raw) ? raw : {};
  const mentions = new Map<string, string>();

  for (const [url, at] of Object.entries(objectField(root, "mentions") ?? {})) {
    if (isJsonString(at)) mentions.set(url, at);
  }

  const cache: MentionCache = { at: numberField(root, "at") ?? 0, mentions };
  const error = stringField(root, "error");

  if (error !== undefined) cache.error = error;

  return cache;
}

const readJson = (path: string): JsonValue => {
  try {
    return parseJson(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

export const readStore = (): SilenceStore => parseStore(readJson(silencePath()));

export const readMentions = (): MentionCache => parseMentions(readJson(mentionsPath()));

function writeJson(path: string, body: JsonObject) {
  mkdirSync(metaDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n");
  renameSync(tmp, path);
}

export function writeStore(store: SilenceStore) {
  const items: JsonObject = {};

  for (const [url, e] of store) items[url] = { state: e.state, at: e.at };
  writeJson(silencePath(), { items });
}

export function writeMentions(cache: MentionCache) {
  const mentions: JsonObject = {};

  for (const [url, at] of cache.mentions) mentions[url] = at;
  const body: JsonObject = { at: cache.at, mentions };

  if (cache.error !== undefined) body.error = cache.error;
  writeJson(mentionsPath(), body);
}

/** When the item's silence started: the user's toggle, or for a team review its first sighting. Undefined when not silenced. */
export function silencedSince(item: Silenceable, store: SilenceStore): string | undefined {
  const entry = store.get(item.url);

  if (entry) return entry.state === "silenced" ? entry.at : undefined;

  return item.group === "team" ? (item.seenAt ?? "") : undefined;
}

/** Whether the item is silenced now: silenced, with no mention of the user since. */
export function isSilenced(item: Silenceable, store: SilenceStore, mentions: ReadonlyMap<string, string>): boolean {
  const since = silencedSince(item, store);

  if (since === undefined) return false;
  const mentioned = mentions.get(item.url);

  if (mentioned === undefined) return true;
  // a team row cached before rows carried `seenAt` has no start, so any mention lifts it
  const sinceMs = since === "" ? -Infinity : Date.parse(since);

  // NaN on either side compares false, so an unreadable time keeps the silence
  return !(Date.parse(mentioned) > sinceMs);
}

/**
 * The store after the user toggles `item`: silenced becomes unsilenced and the other way round. Entries for URLs no
 * tab lists any more are dropped, so the file only holds what is on screen somewhere.
 */
export function toggled(store: SilenceStore, item: Silenceable, mentions: ReadonlyMap<string, string>, now: string, listed: ReadonlySet<string>): SilenceStore {
  const next: SilenceStore = new Map([...store].filter(([url]) => listed.has(url)));
  next.set(item.url, { state: isSilenced(item, store, mentions) ? "unsilenced" : "silenced", at: now });

  return next;
}

/** The URLs whose mentions are worth reading: every silenced entry and every team review, GitHub only. */
export function watchedUrls(rows: readonly Silenceable[], store: SilenceStore): string[] {
  const urls = new Set<string>();

  for (const [url, e] of store) if (e.state === "silenced") urls.add(url);

  for (const r of rows) if (r.group === "team") urls.add(r.url);

  return [...urls].filter(isGithubItem).sort();
}

/** An issue or PR page on github.com, the only kind the mention scan can read. */
export const isGithubItem = (url: string): boolean => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(issues|pull)\/\d+$/.test(url);

/** `rows` with each one's first sighting: kept from `previous` for a URL already listed, else `now`. */
export function carrySeenAt<T extends { url: string; seenAt?: string }>(rows: readonly T[], previous: readonly T[], now: string): T[] {
  const seen = new Map(previous.flatMap((r) => (r.seenAt ? [[r.url, r.seenAt] as const] : [])));

  return rows.map((r) => ({ ...r, seenAt: seen.get(r.url) ?? now }));
}
