import { ATTENTION, type AgentState } from "./agent-state";
import { entries, switchTab } from "./sidebar";

/**
 * The workspace to go to next: the first one after `current` (wrapping) in the most urgent
 * attention state that any workspace is in. Waiting for input comes first, then finished,
 * then finished with background tasks still running. Undefined when nothing needs attention.
 */
export function pickNext(list: { ws: string; state?: AgentState | undefined }[], current: string | undefined): string | undefined {
  const start = list.findIndex((e) => e.ws === current);
  const after = [...list.slice(start + 1), ...list.slice(0, Math.max(0, start))];
  for (const state of ATTENTION) {
    const hit = after.find((e) => e.state === state);
    if (hit) return hit.ws;
  }
  return undefined;
}

/** `overbridge next`: switch to the next workspace that needs attention. */
export function next(current: string | undefined): string {
  const target = pickNext(entries(), current);
  if (!target) return "nothing waiting";
  switchTab(target);
  return `→ ${target}`;
}
