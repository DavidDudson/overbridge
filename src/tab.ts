import { sidebarWidth } from "./config";
import { agentDirOf, workspaceTabSpec } from "./layout";
import { defaultMux, type Mux, TabFocus } from "./mux";
import { selfCommand } from "./paths";
import { log } from "./util";

export { TabFocus };

/** Workspace names in the multiplexer's tab order; empty outside a session. */
export const tabOrder = (mux: Mux = defaultMux()): string[] => mux.tabs();

/** The workspace whose tab is focused; undefined outside a session. */
export const currentTab = (mux: Mux = defaultMux()): string | undefined => mux.currentTab();

/**
 * Open `ws` as a new tab of the running session, its agent starting with `prompt`. In the background
 * (the default) focus returns to the tab you were on. Outside a session there is nothing to add to, so say how to get one.
 */
export function openTab(ws: string, prompt?: string, focus: TabFocus = TabFocus.Background, mux: Mux = defaultMux(), resume = false) {
  if (!mux.inSession()) {
    return log(`${ws} has no tab outside ${mux.kind}; run \`overbridge up\` to open it`);
  }
  const spec = workspaceTabSpec(ws, selfCommand(), { sidebarWidth: sidebarWidth(), focus: true, agentCwd: agentDirOf(ws), ...(prompt ? { prompt } : {}), ...(resume ? { resume } : {}) });
  const r = mux.openTab(spec, focus);
  if (!r.ok) {
    log(`could not open a tab for ${ws}: ${r.error ?? "no reason given"}`);
  }
}
