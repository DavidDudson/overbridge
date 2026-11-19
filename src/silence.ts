import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject, isJsonString, type JsonObject, type JsonValue, numberField, objectField, parseJson, stringField } from "./json";
import { cachedRead } from "./gauge";
import { isGithubItem } from "./mention-scan";
import { metaDir } from "./paths";

/**
 * Silenced list items: a silenced issue or PR stays in its tab, drawn dim, and leaves the sidebar badges.
 * `silenced.json` holds what the user chose, keyed by item URL; only a toggle (a pane's `x` or `overbridge silence
 * toggle`) writes it, so no background writer races the user. `mentions.json` holds the newest comment that mentions the user on each watched item, and
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
  /** The watched URLs and their last updates the scan ran for (`mentionSignature`): a scan for the same set is skipped while young. */
  signature?: string;
}

/** What silence reads from a row of any tab. */
export interface Silenceable {
  url: string;
  /** Reviews tab: a review asked only of a team starts silenced. */
  group?: "direct" | "team";
  /** Reviews tab: when the row first appeared, which is when a team row's silence starts. */
  seenAt?: string;
  /** When GitHub last saw a change to the item (a new comment among them), when the tab knows it. */
  updatedAt?: string;
}

export const silencePath = () => join(metaDir(), "silenced.json");

export const mentionsPath = () => join(metaDir(), "mentions.json");

/** When a pane last started a mention scan (ms, as text): kept apart from `mentions.json` so a claim never overwrites a scan's result. */
export const mentionClaimPath = () => join(metaDir(), "mentions.claim");

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
  const signature = stringField(root, "signature");

  if (signature !== undefined) cache.signature = signature;

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

/** The store for a toggle to write back: a missing file is empty, but an unreadable one throws, so a write never replaces silences it could not read. */
export function readStoreForWrite(): SilenceStore {
  let text: string;

  try {
    text = readFileSync(silencePath(), "utf8");
  } catch (e) {
    if (isRecordWithCode(e) && e.code === "ENOENT") return new Map();
    throw e;
  }

  let raw: JsonValue;

  try {
    raw = parseJson(text);
  } catch {
    throw new Error(`${silencePath()} is not valid JSON; fix or delete it to silence items again`);
  }

  if (!isJsonObject(raw) || !isJsonObject(raw.items)) throw new Error(`${silencePath()} has no "items" mapping; fix or delete it to silence items again`);

  return parseStore(raw);
}

const isRecordWithCode = (e: unknown): e is { code?: unknown } => isJsonObject(e) || e instanceof Error;

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

  if (cache.signature !== undefined) body.signature = cache.signature;
  writeJson(mentionsPath(), body);
}

/**
 * When the item's silence started (ms): the user's toggle, or for a team review its first sighting; `-Infinity` for a
 * team row with no `seenAt`, so any mention lifts it. Undefined when not silenced.
 */
export function silencedSince(item: Silenceable, store: SilenceStore): number | undefined {
  const entry = store.get(item.url);

  if (entry) return entry.state === "silenced" ? Date.parse(entry.at) : undefined;

  if (item.group !== "team") return undefined;

  return item.seenAt === undefined ? -Infinity : Date.parse(item.seenAt);
}

/** Whether the item is silenced now: silenced, with no mention of the user since. */
export function isSilenced(item: Silenceable, store: SilenceStore, mentions: ReadonlyMap<string, string>): boolean {
  const since = silencedSince(item, store);

  if (since === undefined) return false;
  const mentioned = mentions.get(item.url);

  if (mentioned === undefined) return true;

  // NaN on either side compares false, so an unreadable time keeps the silence
  return !(Date.parse(mentioned) > since);
}

/**
 * The store after the user toggles `item`: silenced becomes unsilenced and the other way round. Entries for URLs no
 * tab lists any more are dropped, so the file only holds what is on screen somewhere.
 */
export function toggled(store: SilenceStore, item: Silenceable, mentions: ReadonlyMap<string, string>, now: string, listed: ReadonlySet<string> | undefined): SilenceStore {
  // with no list to compare against, keep every entry rather than drop what an unread list holds
  const next: SilenceStore = new Map(listed ? [...store].filter(([url]) => listed.has(url)) : store);
  next.set(item.url, { state: isSilenced(item, store, mentions) ? "unsilenced" : "silenced", at: now });

  return next;
}

/** The URLs whose mentions are worth reading: every silenced entry and every team review, GitHub only. */
export function watchedUrls(rows: readonly Silenceable[], store: SilenceStore): string[] {
  const urls = new Set<string>();

  for (const [url, e] of store) if (e.state === "silenced") urls.add(url);

  for (const r of rows) if (r.group === "team" && store.get(r.url)?.state !== "unsilenced") urls.add(r.url);

  return [...urls].filter(isGithubItem).sort();
}

/** Whether a row is silenced now, by the store and mentions on disk (each re-read only when its file changed). */
export function silencedNow(): (item: Silenceable) => boolean {
  const store = cachedRead(silencePath(), parseStore) ?? new Map();
  const mentions = cachedRead(mentionsPath(), parseMentions)?.mentions ?? new Map<string, string>();

  return (item) => isSilenced(item, store, mentions);
}

/** The title as drawn: a silenced row leads with a struck bell. */
export const silencedTitle = (title: string, silenced: boolean): string => (silenced ? `🔕 ${title}` : title);

/** `rows` with each one's first sighting: kept from `previous` for a URL already listed, else `now`. */
export function carrySeenAt<T extends { url: string; seenAt?: string }>(rows: readonly T[], previous: readonly T[], now: string): T[] {
  const seen = new Map(previous.flatMap((r) => (r.seenAt ? [[r.url, r.seenAt] as const] : [])));

  return rows.map((r) => ({ ...r, seenAt: seen.get(r.url) ?? now }));
}
