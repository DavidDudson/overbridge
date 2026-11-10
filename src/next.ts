import { ATTENTION, type AgentState } from "./agent-state";
import { entries, switchTab } from "./sidebar";

/**
 * The tab to go to next: the first one after `current` (wrapping) in the most urgent attention
 * state that any tab is in, orchestration tabs included. Waiting for input comes first, then finished,
 * then finished with background tasks still running. Undefined when nothing needs attention.
 */
export function pickNext(list: { tab: string; state?: AgentState | undefined }[], current: string | undefined): string | undefined {
  const start = list.findIndex((e) => e.tab === current);
  const after = [...list.slice(start + 1), ...list.slice(0, Math.max(0, start))];
  for (const state of ATTENTION) {
    const hit = after.find((e) => e.state === state);
    if (hit) return hit.tab;
  }
  return undefined;
}

/**
 * Where to go when `removed` goes away: `previous` (the tab the user came from) when it is still listed, else
 * the next tab needing attention, else the tab after `removed`, else the one before. Undefined when nothing is left.
 */
export function landingTab(list: { tab: string; state?: AgentState | undefined }[], removed: string, previous?: string): string | undefined {
  const others = list.filter((e) => e.tab !== removed);
  if (previous !== undefined && others.some((e) => e.tab === previous)) {
    return previous;
  }
  const at = list.findIndex((e) => e.tab === removed);
  const neighbour = list[at + 1]?.tab ?? (at > 0 ? list[at - 1]?.tab : undefined);
  return pickNext(list, removed) ?? neighbour ?? others[0]?.tab;
}

/** `overbridge next`: switch to the next tab that needs attention. */
export function next(current: string | undefined): string {
  const target = pickNext(entries(), current);
  if (!target) return "nothing waiting";
  switchTab(target);
  return `→ ${target}`;
}
