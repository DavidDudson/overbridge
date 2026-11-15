import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { metaDir } from "./paths";
import type { TopCache } from "./top";

/**
 * The sidebar's task status. A PR's state decides once one exists; before that nothing in git says whether the
 * agent is planning, coding or reviewing, so its Claude records the phase with `overbridge phase`.
 */

/** Phases before a PR exists, which only the agent knows. */
export const PHASES = ["plan", "implement", "mob-review"] as const;

export type Phase = (typeof PHASES)[number];

/** Layer `n` of a stack of `of` layers, 1-based. */
export interface Layer {
  n: number;
  of: number;
}

export interface PhaseRecord {
  phase: Phase;
  /** The stack layer being built, when the work is a stack. */
  layer?: Layer;
  at: number;
}

export const phasePath = (ws: string) => join(metaDir(), "phase", `${ws}.json`);

const PHASE_TEXT: Record<Phase, string> = { plan: "plan", implement: "implement", "mob-review": "mob review" };

/** `2/3` → `{n: 2, of: 3}`; undefined for anything else. */
export function parseLayer(text: string): Layer | undefined {
  const m = /^(\d+)\/(\d+)$/.exec(text);

  if (!m) return undefined;

  return validLayer(Number(m[1]), Number(m[2]));
}

const validLayer = (n: number, of: number): Layer | undefined => (Number.isInteger(n) && Number.isInteger(of) && n >= 1 && n <= of ? { n, of } : undefined);

/** Record `ws`'s phase (atomic rename, so the sidebar never reads half a file). */
export function writePhase(ws: string, phase: Phase, layer?: Layer, now = Date.now()) {
  const file = phasePath(ws);
  mkdirSync(dirname(file), { recursive: true });
  const record: PhaseRecord = { phase, ...(layer ? { layer } : {}), at: now };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(record) + "\n");
  renameSync(tmp, file);
}

export const clearPhase = (ws: string) => rmSync(phasePath(ws), { force: true });

/** The recorded phase of `ws`, or undefined when there is none or the file is unreadable. */
export function readPhase(ws: string): PhaseRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(phasePath(ws), "utf8")) as { phase?: unknown; layer?: { n?: unknown; of?: unknown }; at?: unknown };
    const phase = PHASES.find((p) => p === raw.phase);

    if (!phase) return undefined;
    const layer = typeof raw.layer?.n === "number" && typeof raw.layer.of === "number" ? validLayer(raw.layer.n, raw.layer.of) : undefined;

    return { phase, ...(layer ? { layer } : {}), at: typeof raw.at === "number" ? raw.at : 0 };
  } catch {
    return undefined;
  }
}

const layerText = (l: Layer | undefined) => (l ? ` (stack ${l.n}/${l.of})` : "");

/**
 * The task status of a workspace: the claimed PR's state when it has one, else the phase its agent recorded.
 * Without either: `started` when an item is known, else `ticket` (no item yet).
 */
export function taskStatus(cache: Pick<TopCache, "links" | "merged" | "headline">, phase?: PhaseRecord): string {
  if (cache.merged && Object.keys(cache.merged).length) return "merged";
  const claimed = cache.links.find((l) => l.pr && l.pr.claimed !== false);

  if (claimed?.pr) {
    if (claimed.status === "merged") return "merged";
    const layer = layerText(claimed.pr.layer);

    if (claimed.status === "closed") return "closed PR";

    if (claimed.pr.draft) return `draft PR${layer}`;
    const reviewers = claimed.pr.reviewers ?? [];

    if (claimed.status === "failing") return `build failing${layer}`;

    if (claimed.status === "conflict") return `conflicts${layer}`;

    if (reviewers.some((r) => r.state === "comments" || r.state === "changes")) return `review feedback${layer}`;

    if (reviewers.some((r) => r.state === "reviewing")) return `waiting AI review${layer}`;

    if (claimed.status === "mergeable") return `mergeable${layer}`;

    return `open PR${layer}`;
  }

  if (phase) return `${PHASE_TEXT[phase.phase]}${phase.phase === "implement" ? layerText(phase.layer) : ""}`;

  return cache.headline ? "started" : "ticket";
}
