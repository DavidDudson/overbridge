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

/** Fetch `id`'s title and store it. Keeps the old title when the fetch yields nothing. */
export function refreshTitle(provider: Provider, project: string, id: string): string | undefined {
  const title = provider.title(id);
  if (title === undefined) return cachedTitle(provider, project, id);
  const entries = read();
  entries[keyOf(provider, project, id)] = { title, at: Date.now() };
  mkdirSync(metaDir(), { recursive: true });
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
  renameSync(tmp, file());
  return title;
}
