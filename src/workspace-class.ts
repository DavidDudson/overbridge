import { type ClaimFacts, type ClassInfo, highest } from "./check-priority";
import { itemIdOf } from "./pm";
import type { Provider } from "./pm/provider";
import type { ProjectConfig, ProjectManagement } from "./project-config";
import { cachedFacts, queueClass } from "./worklist-class";
import { readWorklist } from "./worklist-data";

/** One claimed repo of a workspace, as the class rules see it. */
export interface ClaimContext {
  config: ProjectConfig;
  dir: string;
  branch?: string | undefined;
  /** The registered repo name, so a claim finds its item's type and labels in the work list cache. */
  repo?: string | undefined;
}

type MakeProvider = (pm: ProjectManagement, dir: string) => Provider;

/** The type and labels of `item` in `repo`, when something has read them; the default reads the work list cache. */
export type FactsOf = (repo: string, item: string) => Pick<ClaimFacts, "type" | "labels"> | undefined;

const worklistFacts: FactsOf = (repo, item) => cachedFacts(readWorklist().rows, repo, item);

const needsItemFacts = (config: ProjectConfig) => config.checkQueue.priorityRules.some((r) => r.type !== undefined || r.label !== undefined);

/** The class of one claim: its repo's first matching rule, else the repo's `priority`, else the default class. */
export function claimClass({ config, dir, branch, repo }: ClaimContext, make?: MakeProvider, factsOf: FactsOf = worklistFacts): ClassInfo {
  const item = itemIdOf(config.projectManagement, dir, branch, make) || undefined;
  const known = item && repo && needsItemFacts(config) ? factsOf(repo, item) : undefined;

  return queueClass(config.checkQueue, { ...known, branch, item });
}

/** A workspace's class: the highest of its claims', so its card and every check it queues agree. */
export const workspaceClass = (claims: readonly ClaimContext[], make?: MakeProvider, factsOf?: FactsOf): ClassInfo | undefined =>
  highest(claims.map((c) => claimClass(c, make, factsOf)));
