import { spinner } from "./anim";
import { HEALTH_LOOK, type HealthInput, type PrHealth } from "./pr-look";
import type { Ranked } from "./pm/worklist";

// Reuses the PR health looks so one colour means one thing in every tab.

type Item = Pick<Ranked, "status" | "ready">;

export function workHealth(r: Item): PrHealth {
  if (r.status === "blocked") return "changes";

  if (r.status === "done") return "ready";

  if (r.status === "in-progress") return "waiting";

  return r.ready ? "ready" : "draft";
}

/** What `badgeOf` reads: the item as a plain PR-shaped input, so the sidebar knows nothing of work items. */
export function workInput(r: Item): HealthInput {
  const health = workHealth(r);

  return { draft: health === "draft", decision: health === "changes" ? "CHANGES_REQUESTED" : health === "waiting" ? "REVIEW_REQUIRED" : "" };
}

/** The status glyph and colour: a spinner turns on an item in progress, so the list shows what is moving. */
export function statusGlyph(r: Item, nowMs: number) {
  const look = HEALTH_LOOK[workHealth(r)];

  return { icon: r.status === "in-progress" ? spinner(nowMs) : look.icon, color: look.color };
}

/** Whether any row moves, so the pane redraws on a short tick. */
export const workAnimated = (rows: readonly Item[]): boolean => rows.some((r) => r.status === "in-progress");
