import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonNumber, isJsonObject, isJsonString, type JsonValue } from "../json";
import { metaDir } from "../paths";
import type { ItemNode, Provider } from "./provider";

/** Item titles, so rendering never touches the network. Refreshed by `refreshTitle`. */
const file = () => join(metaDir(), "titles.json");

/** Item lineages (the item and its parents), refreshed by `refreshLineage`. */
const lineageFile = () => join(metaDir(), "lineage.json");

type Entry = { title: string; at: number };

type LineageEntry = { nodes: ItemNode[]; at: number };

function readStore<T>(path: string): Record<string, T> {
  if (!existsSync(path)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function writeStore<T>(path: string, entries: Record<string, T>) {
  mkdirSync(metaDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
  renameSync(tmp, path);
}

const read = () => readStore<Entry>(file());

const keyOf = (provider: Provider, project: string, id: string) => `${provider.name}:${project}:${id}`;

/** The last title fetched for `id`, or undefined. Never hits the network. */
export function cachedTitle(provider: Provider, project: string, id: string): string | undefined {
  return read()[keyOf(provider, project, id)]?.title;
}

/** A title is refetched when its stored one is older than this: an item is renamed rarely, a refresh runs every minute. */
export const TITLE_TTL_MS = 10 * 60_000;

/**
 * Fetch `id`'s title and store it, unless the stored one is under `ttlMs` old (then the network is not touched). Keeps
 * the old title when the fetch yields nothing.
 */
export function refreshTitle(provider: Provider, project: string, id: string, o: { ttlMs?: number; now?: number } = {}): string | undefined {
  const now = o.now ?? Date.now();
  const stored = read()[keyOf(provider, project, id)];

  if (stored && o.ttlMs !== undefined && now - stored.at < o.ttlMs) return stored.title;
  const title = provider.title(id);

  if (title === undefined) return cachedTitle(provider, project, id);
  writeStore(file(), { ...read(), [keyOf(provider, project, id)]: { title, at: now } });

  return title;
}

/** The stored lineage for `key`, or undefined when it is missing or misshapen. */
function storedLineage(key: string): LineageEntry | undefined {
  const raw = readStore<JsonValue>(lineageFile())[key];

  if (!isJsonObject(raw) || !isJsonNumber(raw.at) || !Array.isArray(raw.nodes)) {
    return undefined;
  }

  const nodes = raw.nodes.flatMap((n): ItemNode[] =>
    isJsonObject(n) && isJsonString(n.id) && isJsonString(n.title) && isJsonString(n.status) && isJsonString(n.url) ? [{ id: n.id, title: n.title, status: n.status, url: n.url }] : [],
  );

  return nodes.length && nodes.length === raw.nodes.length ? { nodes, at: raw.at } : undefined;
}

/** `id`'s lineage, refetched once the stored one is `ttlMs` old; an empty fetch keeps the stored one, so an outage never empties the panel. */
export function refreshLineage(provider: Provider, project: string, id: string, o: { ttlMs?: number; now?: number } = {}): ItemNode[] {
  const now = o.now ?? Date.now();
  const key = keyOf(provider, project, id);
  const stored = storedLineage(key);
  const storedNodes = stored?.nodes ?? [];

  if (stored && o.ttlMs !== undefined && now - stored.at < o.ttlMs) {
    return storedNodes;
  }

  const nodes = provider.lineage(id);

  if (!nodes.length) {
    return storedNodes;
  }

  writeStore(lineageFile(), { ...readStore<JsonValue>(lineageFile()), [key]: { nodes, at: now } });

  return nodes;
}
