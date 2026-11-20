import { type ClaimFacts, type ClassInfo, highest, queueClass } from "./check-priority";
import { itemIdOf } from "./pm";
import type { Provider } from "./pm/provider";
import type { ProjectConfig, ProjectManagement } from "./project-config";

/** One claimed repo of a workspace, as the class rules see it. */
export interface ClaimContext {
  config: ProjectConfig;
  dir: string;
  branch?: string | undefined;
  /** The registered repo name, so `type` and `label` rules can look up the claim's item. */
  repo?: string | undefined;
}

type MakeProvider = (pm: ProjectManagement, dir: string) => Provider;

/** The type and labels of `item` in `repo`, or undefined when nothing has read the item; production callers pass `worklistFacts`. */
export type FactsOf = (repo: string, item: string) => Pick<ClaimFacts, "type" | "labels"> | undefined;

const needsItemFacts = (config: ProjectConfig) => config.checkQueue.priorityRules.some((r) => r.type !== undefined || r.label !== undefined);

/** The class of one claim: its repo's first matching rule, else the repo's `priority`, else the default class. */
export function claimClass({ config, dir, branch, repo }: ClaimContext, factsOf: FactsOf, make?: MakeProvider): ClassInfo {
  const item = itemIdOf(config.projectManagement, dir, branch, make) || undefined;
  const known = item && repo && needsItemFacts(config) ? factsOf(repo, item) : undefined;

  return queueClass(config.checkQueue, { ...known, branch, item });
}

/** A workspace's class: the highest of its claims', so its card and every check it queues agree. */
export const workspaceClass = (claims: readonly ClaimContext[], factsOf: FactsOf, make?: MakeProvider): ClassInfo | undefined =>
  highest(claims.map((c) => claimClass(c, factsOf, make)));
