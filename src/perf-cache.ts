import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { historyStore, type HistoryStore } from "./history";
import { computeViews, type WindowView } from "./history-report";
import { isJsonObject, type JsonObject, type JsonValue, numberField, objectField, parseJson } from "./json";
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
  // it holds command lines, like the history files it comes from
  writeFileSync(tmp, JSON.stringify(views), { mode: 0o600 });
  renameSync(tmp, file);
}

/** A window holds its workspace and repo summaries; the summaries themselves are trusted, as `writePerfCache` alone writes the file. */
const isWindowView = (value: JsonObject): value is JsonObject & WindowView => "workspaces" in value && Array.isArray(value.workspaces) && "repos" in value && Array.isArray(value.repos);


/** The views in a parsed cache file, or undefined when it is not one. */
function decodePerfViews(value: JsonValue): PerfViews | undefined {
  if (!isJsonObject(value)) return undefined;
  const at = numberField(value, "at");
  const windows = objectField(value, "windows");

  if (at === undefined || !windows) return undefined;

  const views: Record<string, WindowView> = {};

  for (const [label, view] of Object.entries(windows)) {
    if (!isJsonObject(view) || !isWindowView(view)) return undefined;
    views[label] = view;
  }

  return { at, windows: views };
}

/** The cache file, or undefined when it is missing or not a valid one. */
export function readPerfCache(file = perfCacheFile()): PerfViews | undefined {
  try {
    return decodePerfViews(parseJson(readFileSync(file, "utf8")));
  } catch {
    // missing or half written: compute instead
    return undefined;
  }
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
