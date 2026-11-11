import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { historyStore, type HistoryStore } from "./history";
import { computeViews, type WindowView } from "./history-report";
import { metaDir } from "./paths";

/**
 * The perf tab's views of the history (every window, by workspace and by repo, with the aggregates), computed once
 * and written to `<meta>/perf.json`. The server is the usual writer; a pane that finds the file missing or old
 * computes the same views itself, so the tab works with no server.
 */

export interface PerfViews {
  /** Epoch ms when the views were computed. */
  at: number;
  windows: Record<string, WindowView>;
}

/** A pane trusts a cache file this young; the server refreshes it more often than this. */
export const PERF_CACHE_MAX_AGE_MS = 30_000;

export const perfCacheFile = () => join(metaDir(), "perf.json");

/** Compute every view now. */
export function computePerf(store: HistoryStore = historyStore(), now = Date.now()): PerfViews {
  return { at: now, windows: computeViews(store, now) };
}

/** Write by rename, so a pane never reads half a file. */
export function writePerfCache(views: PerfViews, file = perfCacheFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(views));
  renameSync(tmp, file);
}

/** The cache file, or undefined when it is missing or not a valid one. */
export function readPerfCache(file = perfCacheFile()): PerfViews | undefined {
  try {
    const v: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (v && typeof v === "object" && typeof (v as PerfViews).at === "number" && typeof (v as PerfViews).windows === "object") return v as PerfViews;
  } catch {
    // missing or half written: compute instead
  }
  return undefined;
}

/** The views a pane shows: the cache file while it is young, else computed here. */
export function loadPerf(o: { read?: () => PerfViews | undefined; compute?: () => PerfViews; now?: number } = {}): PerfViews {
  const now = o.now ?? Date.now();
  const cached = (o.read ?? readPerfCache)();
  if (cached && now - cached.at < PERF_CACHE_MAX_AGE_MS) return cached;
  return (o.compute ?? computePerf)();
}

/** The server's refresh: compute every view and write the cache file. */
export function refreshPerf(store: HistoryStore = historyStore(), now = Date.now(), file = perfCacheFile()): PerfViews {
  const views = computePerf(store, now);
  writePerfCache(views, file);
  return views;
}
