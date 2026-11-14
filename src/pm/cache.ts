import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { metaDir } from "../paths";
import type { Provider } from "./provider";

/** Item titles, so rendering never touches the network. Refreshed by `refreshTitle`. */
const file = () => join(metaDir(), "titles.json");

type Entry = { title: string; at: number };

function read(): Record<string, Entry> {
  if (!existsSync(file())) return {};
  try {
    return JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

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
  const entries = read();
  entries[keyOf(provider, project, id)] = { title, at: now };
  mkdirSync(metaDir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
  renameSync(tmp, file());
  return title;
}
