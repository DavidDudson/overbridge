import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { metaDir } from "./paths";

/**
 * Slow-changing values (who `gh` is signed in as, a repo's merge settings) kept for a TTL in `<meta>/values.json`, so
 * every process (pane, hook child, server worker) reads one fetch instead of making its own. A file, not the server's
 * memory: the callers are synchronous and must work with the server down. Imports node builtins and `paths.ts` only.
 */

export const USER_TTL_MS = 60 * 60_000;
export const MERGE_SETTINGS_TTL_MS = 60 * 60_000;

type Entry = { value: string; at: number };
const file = () => join(metaDir(), "values.json");

function read(): Record<string, Entry> {
  try {
    return JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    return {};
  }
}

/**
 * The value for `key`: the stored one while it is under `ttlMs` old, else `fetch()`'s result, stored. A failed fetch
 * (undefined) serves the last stored value of any age, so an outage never blanks it; with none, undefined.
 */
export function cachedValue(key: string, ttlMs: number, fetch: () => string | undefined, now = Date.now()): string | undefined {
  const entry = read()[key];
  if (entry && now - entry.at < ttlMs) return entry.value;
  const value = fetch();
  if (value === undefined) return entry?.value;
  try {
    const entries = { ...read(), [key]: { value, at: now } };
    mkdirSync(metaDir(), { recursive: true });
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n");
    renameSync(tmp, file());
  } catch {
    // an unwritable cache only costs the next caller a fetch
  }
  return value;
}

/**
 * Changes when the signed-in `gh` account does: `gh auth switch` and `gh auth login` rewrite `hosts.yml`, and a token in
 * the environment names the account directly. Part of any key whose value belongs to the account.
 */
export function ghAccountStamp(): string {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (token) return `token-${Bun.hash(token).toString(36)}`;
  const dir = process.env.GH_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "gh");
  try {
    return String(Math.trunc(statSync(join(dir, "hosts.yml")).mtimeMs));
  } catch {
    return "none";
  }
}
