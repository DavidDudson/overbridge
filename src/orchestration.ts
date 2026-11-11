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
  /** A pane that replaces Claude: the tab runs `overbridge <pane>` beside its sidebar and has no agent. */
  pane?: string;
}

export const ORCHESTRATION_TABS: readonly OrchestrationTab[] = [
  { tab: "@root", label: "overbridge root", dir: root },
  { tab: "@work", label: "work list", dir: root, pane: "worklist" },
  { tab: "@prs", label: "my PRs", dir: root, pane: "prs" },
  { tab: "@reviews", label: "reviews", dir: root, pane: "reviews" },
];

export const orchestrationTab = (tab: string): OrchestrationTab | undefined => ORCHESTRATION_TABS.find((t) => t.tab === tab);

/** Whether `name` is an orchestration tab, which no removal path may touch. */
export const isOrchestrationTab = (name: string): boolean => orchestrationTab(name) !== undefined;

/** Why `name` can't be removed, for every removal path to report the same way. */
export const orchestrationRemoveMessage = (name: string) =>
  `${name} is an orchestration tab, which always stays open; it can't be removed or cleaned up`;
