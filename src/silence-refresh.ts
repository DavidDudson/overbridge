import { readPrList } from "./prlist-data";
import { readWorklist } from "./worklist-data";
import { scanMentions } from "./mention-scan";
import { selfCommand } from "./paths";
import { cachedRead } from "./gauge";
import { isSilenced, type MentionCache, mentionsPath, parseMentions, parseStore, silencePath, readMentions, readStore, type Silenceable, type SilenceState, toggled, watchedUrls, writeMentions, writeStore } from "./silence";
import { errorMessage, run, spawnCwd, type RunResult } from "./util";

/** The silence store's I/O against the list caches: the scan that `overbridge silence refresh` runs, and the pane toggle. */

/** The least time between two mention scans a pane starts. */
export const MENTION_REFRESH_MS = 30_000;

/** Every row the three tabs list, as silence reads it. */
export function listedRows(): Silenceable[] {
  return [...readPrList("prs").rows, ...readPrList("reviews").rows, ...readWorklist().rows];
}

type Runner = (cmd: string[]) => RunResult;

/** Scan every watched URL for a mention and write `mentions.json`. A failed scan keeps the last mentions and records why. */
export function refreshMentions(now = Date.now(), runner: Runner = run): MentionCache {
  const urls = watchedUrls(listedRows(), readStore());
  let cache: MentionCache;

  try {
    cache = { at: now, mentions: urls.length ? scanMentions(urls, login(runner), runner) : new Map() };
  } catch (e) {
    cache = { ...readMentions(), at: now, error: errorMessage(e) };
  }

  writeMentions(cache);

  return cache;
}

function login(runner: Runner): string {
  const who = runner(["gh", "api", "user", "--jq", ".login"]);

  if (!who.ok) throw new Error(`gh api user failed: ${(who.stderr || who.stdout).trim().split("\n")[0]}`);

  return who.stdout.trim();
}

/** Flip `item`'s silence and save it; returns the state it now has. */
export function toggleSilence(item: Silenceable, now = new Date()): SilenceState {
  const store = readStore();
  const listed = new Set([...listedRows().map((r) => r.url), item.url]);
  const next = toggled(store, item, readMentions().mentions, now.toISOString(), listed);
  writeStore(next);

  return next.get(item.url)?.state ?? "unsilenced";
}

/** `toggleSilence` as a pane footer: `silenced <label>`, or the error when the store could not be written. */
export function toggleMessage(item: Silenceable, label: string): string {
  try {
    return `${toggleSilence(item)} ${label}`;
  } catch (e) {
    return `error: could not save the silence for ${label}: ${errorMessage(e)}`;
  }
}

/** The URLs of `rows` silenced now, for a view to dim. */
export function silencedSet(rows: readonly Silenceable[]): Set<string> {
  const store = cachedRead(silencePath(), parseStore) ?? new Map();
  const mentions = cachedRead(mentionsPath(), parseMentions)?.mentions ?? new Map<string, string>();

  return new Set(rows.flatMap((r) => (isSilenced(r, store, mentions) ? [r.url] : [])));
}

/** Starts `overbridge silence refresh` in the background, at most once per `MENTION_REFRESH_MS`. */
export function spawnMentionRefresh(now = Date.now()) {
  if (now - readMentions().at < MENTION_REFRESH_MS) return;
  Bun.spawn({ cmd: [...selfCommand(), "silence", "refresh"], cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
}
