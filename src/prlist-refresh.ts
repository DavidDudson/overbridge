import { loadRootLayers } from "./project-config";
import { type PrListCache, type PrListKind, readPrList, writePrList } from "./prlist-data";
import { combinedSignature, MAX_PAGE, pageFor, type Probe, readProbe } from "./prlist-probe";
import type { PrRow } from "./pr-rows";
import { readMyPrs, searchQuery } from "./prs-refresh";
import { filterOrgs, mergeRows, REVIEW_PAGE, reviewCommand, rowsFromReviews, searchString } from "./review-batch";
import { carrySeenAt } from "./silence";
import { errorMessage, run, type RunResult } from "./util";
import { githubLogin } from "./gh-login";

/** Reading the two PR lists into their caches, with no pane code, so the server's worker can run it. */

/** A list whose probe has not changed is still read in full this often, for what the probe cannot see (a check inside a pending rollup, a bot's comment count). */
export const FULL_MAX_AGE_MS = 10 * 60_000;

type Runner = (cmd: string[]) => RunResult;

const firstLine = (r: RunResult) => (r.stderr || r.stdout).trim().split("\n")[0];

/** The owners the reviews tab searches one at a time; no orgs means one search over every owner. */
const reviewOrgs = (orgs: readonly string[]): (string | undefined)[] => (orgs.length ? [...orgs] : [undefined]);

/** The reviews asked of me: one GraphQL search per owner, so each row carries its request, bots, CI and merge state. `pages` sizes each search, in `orgs` order. */
export function readReviews(orgs: readonly string[], runner: Runner = run, pages: readonly number[] = [], login?: string): PrRow[] {
  const me = login ?? githubLogin(runner);

  const lists = reviewOrgs(orgs).map((org, i) => {
    const r = runner(reviewCommand(me, org, pages[i] ?? REVIEW_PAGE));

    if (!r.ok) {
      throw new Error(`gh api graphql failed: ${firstLine(r)}`);
    }

    return rowsFromReviews(r.stdout, me);
  });

  return filterOrgs(mergeRows(lists), orgs);
}

/** Read one list in full. `pages` sizes each search. Throws with `gh`'s message when a search fails. */
export function readPrs(kind: PrListKind, orgs: readonly string[], runner: Runner = run, pages: readonly number[] = [], login?: string): PrRow[] {
  return kind === "reviews" ? readReviews(orgs, runner, pages, login) : readMyPrs(orgs, runner, pages[0] ?? MAX_PAGE);
}

/** Probe each search the full read of `kind` runs, in the same order. */
function probeList(kind: PrListKind, orgs: readonly string[], runner: Runner, login: string | undefined): Probe[] {
  if (kind === "prs") {
    return [readProbe(searchQuery(orgs), runner)];
  }

  return reviewOrgs(orgs).map((org) => readProbe(searchString(login ?? "", org), runner));
}

/** Whether a refresh may keep the cached rows: the probe matches what they were read after, and they are young and whole. */
export const keepRows = (old: PrListCache, signature: string, now: number): boolean =>
  old.error === undefined && old.signature === signature && old.fullAt !== undefined && now - old.fullAt < FULL_MAX_AGE_MS;

/**
 * `overbridge prs refresh` / `reviews refresh`: probe the list and read it in full only when the probe changed, the rows
 * are old, the last read failed, or `force` (the user's `r`). A failed read keeps the old rows.
 */
export function refreshPrList(kind: PrListKind, now = Date.now(), runner: Runner = run, o: { force?: boolean } = {}): PrListCache {
  const orgs = loadRootLayers().githubOrgs;
  const old = readPrList(kind);
  let cache: PrListCache;

  try {
    const login = kind === "reviews" ? githubLogin(runner) : undefined;
    const probes = probeList(kind, orgs, runner, login);
    const signature = combinedSignature(probes);

    if (!o.force && keepRows(old, signature, now)) {
      cache = { ...old, at: now };
    } else {
      const pages = probes.map((p) => Math.min(kind === "reviews" ? REVIEW_PAGE : MAX_PAGE, pageFor(p.count)));
      const rows = carrySeenAt(readPrs(kind, orgs, runner, pages, login), old.rows, new Date(now).toISOString());
      cache = { at: now, rows, signature, fullAt: now };
    }
  } catch (e) {
    // `keepRows` refuses a cache with an error, so the next refresh reads in full
    cache = { ...old, at: now, error: errorMessage(e) };
  }

  writePrList(kind, cache);

  return cache;
}
