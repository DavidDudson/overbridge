import { sidebarWidth } from "./config";
import { agentDirOf, workspaceTabSpec } from "./layout";
import { defaultMux, type Mux, type MuxResult, TabFocus } from "./mux";
import { selfCommand } from "./paths";
import { fail, log, shellQuote } from "./util";

export { TabFocus };

/** Workspace names in the multiplexer's tab order; empty outside a session. */
export const tabOrder = (mux: Mux = defaultMux()): string[] => mux.tabs();

/** The workspace whose tab is focused; undefined outside a session. */
export const currentTab = (mux: Mux = defaultMux()): string | undefined => mux.currentTab();

/** Pauses between attempts to open a tab; a transient session miss (a busy server) usually clears within a second. Tests zero it. */
export const tabRetry = { delaysMs: [250, 500], sleep: (ms: number) => Bun.sleepSync(ms) };

/**
 * Open `ws` as a new tab of the running session, its agent starting with `prompt`. In the background
 * (the default) focus returns to the tab you were on. Outside a session there is nothing to add to, so say how to get one.
 * A failed open is retried; a tab that appeared despite the failure counts as opened, so a retry never doubles it.
 */
export function openTab(ws: string, prompt?: string, focus: TabFocus = TabFocus.Background, mux: Mux = defaultMux(), resume = false): MuxResult {
  if (!mux.inSession()) {
    log(`${ws} has no tab outside ${mux.kind}; run \`overbridge up\` to open it`);
    return { ok: true };
  }
  const spec = workspaceTabSpec(ws, selfCommand(), { sidebarWidth: sidebarWidth(), focus: true, agentCwd: agentDirOf(ws), ...(prompt ? { prompt } : {}), ...(resume ? { resume } : {}) });
  let r = mux.openTab(spec, focus);
  for (const delay of tabRetry.delaysMs) {
    if (r.ok) break;
    log(`could not open a tab for ${ws}: ${r.error ?? "no reason given"}; retrying`);
    tabRetry.sleep(delay);
    if (mux.tabs().includes(ws)) return { ok: true };
    r = mux.openTab(spec, focus);
  }
  if (!r.ok) {
    log(`could not open a tab for ${ws}: ${r.error ?? "no reason given"}`);
  }
  return r;
}

/** The command that opens `ws`'s tab later, from inside the session. */
export const tabCommand = (ws: string, prompt?: string) => `overbridge tab ${shellQuote(ws)}${prompt ? ` --prompt ${shellQuote(prompt)}` : ""}`;

/** `openTab`, but a tab that never opened fails the command, naming the one that recovers it. */
export function requireTab(ws: string, prompt?: string, focus: TabFocus = TabFocus.Background, mux: Mux = defaultMux(), resume = false) {
  const r = openTab(ws, prompt, focus, mux, resume);
  if (!r.ok) {
    fail(`${ws} exists but its tab did not open (${r.error ?? "no reason given"}). Open it with: ${tabCommand(ws, resume ? undefined : prompt)}`);
  }
}
