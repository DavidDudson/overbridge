import { focusClaude } from "./panes";
import { orchestrationTab } from "./orchestration";
import { entries } from "./sidebar";
import { currentTab, sessionExec, tabOrder, type ZellijExec } from "./tab";
import { OverbridgeError } from "./util";

export const GO_USAGE = "usage: overbridge go <n>|<name>|next|prev";

/**
 * Which tab `arg` asks for among `tabs` (the sidebar's order, so numbers match its digits): a 1-based
 * number, `next` or `prev` from `current` (wrapping), or a name (`root` reaches `@root`). An error says why not.
 */
export function pickGo(tabs: string[], current: string | undefined, arg: string): { tab: string } | { error: string } {
  if (/^\d+$/.test(arg)) {
    const n = Number(arg);
    const tab = n >= 1 ? tabs[n - 1] : undefined;
    return tab === undefined ? { error: `no tab ${n}: ${tabs.length} tab${tabs.length === 1 ? "" : "s"}` } : { tab };
  }
  if (arg === "next" || arg === "prev") {
    const at = current === undefined ? -1 : tabs.indexOf(current);
    if (at < 0) return { error: "not on a tab" };
    if (tabs.length < 2) return { error: "only one tab" };
    return { tab: tabs[(at + (arg === "next" ? 1 : tabs.length - 1)) % tabs.length]! };
  }
  if (tabs.includes(arg)) return { tab: arg };
  const orchestration = orchestrationTab(`@${arg}`)?.tab;
  if (orchestration !== undefined && tabs.includes(orchestration)) return { tab: orchestration };
  return { error: `no tab '${arg}'` };
}

/**
 * `overbridge go <n>|<name>|next|prev`: switch to the tab and focus its Claude pane. Reaches the session by name
 * when run outside it. The sidebar's history is not touched, like `overbridge next`.
 */
export function go(arg: string, exec: ZellijExec = sessionExec()): string {
  const tabs = entries(tabOrder(exec)).map((e) => e.tab);
  const picked = pickGo(tabs, currentTab(exec), arg);
  if ("error" in picked) throw new OverbridgeError(picked.error);
  const r = exec(["zellij", "action", "go-to-tab-name", picked.tab]);
  if (!r.ok) throw new OverbridgeError(`could not switch to ${picked.tab}: ${r.stderr || r.stdout || "no session"}`.trim());
  focusClaude(picked.tab, exec);
  return `→ ${picked.tab}`;
}
