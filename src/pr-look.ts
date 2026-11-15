import type { Color } from "./term";

/** How a PR looks in a list: one glyph, one colour, one word. Shared by every PR-listing tab. */
export interface Look {
  icon: string;
  color: Color;
  label: string;
}

export type MergeState = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export type CiState = "success" | "failure" | "pending" | "none";

/** GitHub's `reviewDecision`; empty when the repo requires no review. */
export type Decision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | "";

/** Merge conflicts are the loudest cue a row has: red, and animated by the views. */
export function conflictLook(mergeable: string | undefined): Look {
  if (mergeable === "CONFLICTING") return { icon: "💥", color: "red", label: "conflict" };

  if (mergeable === "MERGEABLE") return { icon: "🟢", color: "green", label: "clean" };

  return { icon: "⚪", color: "grey", label: "unknown" };
}

const CI_LOOK: Record<CiState, Look> = {
  success: { icon: "🟢", color: "green", label: "passing" },
  failure: { icon: "🔴", color: "red", label: "failing" },
  pending: { icon: "🟡", color: "yellow", label: "running" },
  none: { icon: "⚪", color: "grey", label: "no checks" },
};

export const ciLook = (ci: CiState | undefined): Look => CI_LOOK[ci ?? "none"];

/** GitHub's rollup `state` (`SUCCESS`, `FAILURE`, `ERROR`, `PENDING`, `EXPECTED`) as a `CiState`. */
export function ciFromRollup(state: string | undefined): CiState {
  if (state === "SUCCESS") return "success";

  if (state === "FAILURE" || state === "ERROR") return "failure";

  if (state === "PENDING" || state === "EXPECTED") return "pending";

  return "none";
}

/** What a PR needs, worst first. `rank` orders icons in a badge. */
export type PrHealth = "conflict" | "changes" | "failing" | "waiting" | "draft" | "ready";

export const HEALTH_LOOK: Record<PrHealth, Look & { rank: number; alt: string }> = {
  conflict: { icon: "💥", alt: "🔥", color: "red", label: "merge conflict", rank: 0 },
  changes: { icon: "🔴", alt: "🔴", color: "red", label: "changes requested", rank: 1 },
  failing: { icon: "❌", alt: "❌", color: "red", label: "checks failing", rank: 2 },
  waiting: { icon: "🟡", alt: "🟡", color: "yellow", label: "waiting", rank: 3 },
  draft: { icon: "⚪", alt: "⚪", color: "grey", label: "draft", rank: 4 },
  ready: { icon: "🟢", alt: "🟢", color: "green", label: "ready", rank: 5 },
};

export interface HealthInput {
  draft: boolean;
  mergeable?: string | undefined;
  ci?: CiState | undefined;
  decision?: string | undefined;
}

/** The single state that sums a PR up: the worst thing about it. */
export function healthOf(p: HealthInput): PrHealth {
  if (p.mergeable === "CONFLICTING") return "conflict";

  if (p.decision === "CHANGES_REQUESTED") return "changes";

  if (p.ci === "failure") return "failing";

  if (p.draft) return "draft";

  if (p.ci === "pending" || p.decision === "REVIEW_REQUIRED") return "waiting";

  return "ready";
}
