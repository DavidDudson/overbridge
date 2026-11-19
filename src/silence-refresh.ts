import { readPrList } from "./prlist-data";
import { readWorklist } from "./worklist-data";
import { scanMentions } from "./mention-scan";
import { metaDir, selfCommand } from "./paths";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { type MentionCache, mentionClaimPath, readMentions, readStore, readStoreForWrite, type Silenceable, silencedNow, type SilenceState, toggled, watchedUrls, writeMentions, writeStore } from "./silence";
import { errorMessage, run, spawnCwd, type RunResult } from "./util";
import { githubLogin } from "./gh-login";

/** The silence store's I/O against the list caches: the scan that `overbridge silence refresh` runs, and the pane toggle. */

/** The least time between two mention scans a pane starts. */
export const MENTION_REFRESH_MS = 30_000;

/** Every row the three tabs list, as silence reads it. */
export function listedRows(): Silenceable[] {
  return [...readPrList("prs").rows, ...readPrList("reviews").rows, ...readWorklist().rows];
}

/** The URLs every tab lists, or undefined while any list has never been read, when pruning would drop that list's silences. */
export function listedUrls(): Set<string> | undefined {
  const lists = [readPrList("prs"), readPrList("reviews"), readWorklist()];

  return lists.some((l) => l.at === 0) ? undefined : new Set(lists.flatMap((l) => l.rows.map((r) => r.url)));
}

type Runner = (cmd: string[]) => RunResult;

/** A scan of an unchanged set still runs this often: an item a tab lists with no update time (a work-list issue) changes unseen. */
export const MENTION_MAX_AGE_MS = 10 * 60_000;

/** The watched URLs with each one's last update as the tabs list it: a new comment changes the update time. */
export const mentionSignature = (urls: readonly string[], rows: readonly Silenceable[]): string => {
  const updated = new Map(rows.map((r) => [r.url, r.updatedAt ?? ""]));

  return urls.map((u) => `${u} ${updated.get(u) ?? ""}`).join("\n");
};

/**
 * Scan every watched URL for a mention and write `mentions.json`. Skipped, keeping the last scan, while no watched item
 * changed and that scan is young and good. A failed scan keeps the last mentions and records why.
 */
export function refreshMentions(now = Date.now(), runner: Runner = run): MentionCache {
  const rows = listedRows();
  const urls = watchedUrls(rows, readStore());
  const signature = mentionSignature(urls, rows);
  const old = readMentions();

  if (old.error === undefined && old.signature === signature && now - old.at < MENTION_MAX_AGE_MS) {
    return old;
  }

  let cache: MentionCache;

  try {
    cache = { at: now, mentions: urls.length ? keepNewest(old.mentions, scanMentions(urls, githubLogin(runner), runner), urls) : new Map(), signature };
  } catch (e) {
    const { signature: _stale, ...kept } = old;
    cache = { ...kept, at: now, error: errorMessage(e) };
  }

  writeMentions(cache);

  return cache;
}

/**
 * The newest mention per watched URL, from this scan or the last: the scan reads a fixed window of recent comments,
 * so a mention that has scrolled out of it still counts. URLs no longer watched are dropped.
 */
export function keepNewest(previous: ReadonlyMap<string, string>, found: ReadonlyMap<string, string>, urls: readonly string[]): Map<string, string> {
  return new Map(
    urls.flatMap((url) => {
      const times = [previous.get(url), found.get(url)].flatMap((t) => (t === undefined ? [] : [t]));
      const newest = times.toSorted((a, b) => Date.parse(b) - Date.parse(a))[0];

      return newest === undefined ? [] : [[url, newest] as const];
    }),
  );
}

/** Flip `item`'s silence and save it; returns the state it now has. */
export function toggleSilence(item: Silenceable, now = new Date()): SilenceState {
  const store = readStoreForWrite();
  const next = toggled(store, item, readMentions().mentions, now.toISOString(), listedUrls());
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
  const silenced = silencedNow();

  return new Set(rows.flatMap((r) => (silenced(r) ? [r.url] : [])));
}

/** The last mention scan's failure as a pane footer, or empty when it worked. */
export function mentionScanError(): string {
  const { error } = readMentions();

  return error ? `error: mention scan failed: ${error}` : "";
}

const spawnDetached = (cmd: string[]) => {
  Bun.spawn({ cmd, cwd: spawnCwd(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
};

/** When a pane last claimed a scan (ms); 0 when none has. */
function claimedAt(): number {
  try {
    return Number(readFileSync(mentionClaimPath(), "utf8")) || 0;
  } catch {
    return 0;
  }
}

/** Starts `overbridge silence refresh` in the background, at most once per `MENTION_REFRESH_MS`; returns a pane footer when it could not. */
export function spawnMentionRefresh(now = Date.now(), spawn: (cmd: string[]) => void = spawnDetached): string {
  if (now - Math.max(readMentions().at, claimedAt()) < MENTION_REFRESH_MS) return "";

  try {
    // claim the window before the scan runs, so panes that refresh together start one scan, not one each
    mkdirSync(metaDir(), { recursive: true });
    writeFileSync(mentionClaimPath(), String(now));
  } catch (e) {
    return `error: could not start the mention scan: ${errorMessage(e)}`;
  }

  spawn([...selfCommand(), "silence", "refresh"]);

  return "";
}
