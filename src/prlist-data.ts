import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { metaDir } from "./paths";
import type { PrRow } from "./pr-rows";

/** The PR list caches with no pane code, so the silence scan can read them without importing the panes. */

/** The two PR lists in the orchestration tabs: PRs you opened, and PRs waiting for your review. */
export type PrListKind = "prs" | "reviews";

export interface PrListCache {
  at: number;
  rows: PrRow[];
  /** Why the last read failed, if it did. */
  error?: string;
  /** The probe the rows were read after (`prlist-probe.ts`): a refresh whose probe matches it keeps the rows. */
  signature?: string;
  /** When the rows were last read in full. */
  fullAt?: number;
}

export const prListPath = (kind: PrListKind) => join(metaDir(), `prlist-${kind}.json`);

export function readPrList(kind: PrListKind): PrListCache {
  try {
    return JSON.parse(readFileSync(prListPath(kind), "utf8"));
  } catch {
    return { at: 0, rows: [] };
  }
}

export function writePrList(kind: PrListKind, cache: PrListCache) {
  mkdirSync(metaDir(), { recursive: true });
  const tmp = `${prListPath(kind)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2) + "\n");
  renameSync(tmp, prListPath(kind));
}
