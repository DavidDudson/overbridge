import { root } from "./paths";

/**
 * Tabs for work across workspaces, listed above the workspaces in the sidebar. Their names start with
 * `@`, which `NAME_RE` rejects, so they never clash with a workspace's tab, agent state or sidebar file.
 */
export interface OrchestrationTab {
  /** The zellij tab name, also the key for its agent state and sidebar pane. */
  tab: string;
  /** What the sidebar shows. */
  label: string;
  /** Where its Claude runs. */
  dir: () => string;
}

export const ORCHESTRATION_TABS: readonly OrchestrationTab[] = [{ tab: "@root", label: "overbridge root", dir: root }];

export const orchestrationTab = (tab: string): OrchestrationTab | undefined => ORCHESTRATION_TABS.find((t) => t.tab === tab);
