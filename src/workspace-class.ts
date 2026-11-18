import { type ClassInfo, classInfo, defaultClassName, highest, priorityOf } from "./check-priority";
import { itemIdOf } from "./pm";
import type { Provider } from "./pm/provider";
import type { ProjectConfig, ProjectManagement } from "./project-config";

/** One claimed repo of a workspace, as the class rules see it. */
export interface ClaimContext {
  config: ProjectConfig;
  dir: string;
  branch?: string | undefined;
}

type MakeProvider = (pm: ProjectManagement, dir: string) => Provider;

/** The class of one claim: its repo's first matching rule, else the repo's `priority`, else the default class. */
export function claimClass({ config, dir, branch }: ClaimContext, make?: MakeProvider): ClassInfo {
  const queue = config.checkQueue;
  const item = itemIdOf(config.projectManagement, dir, branch, make) || undefined;

  return classInfo(queue.classes, priorityOf(queue.priorityRules, queue.priority ?? defaultClassName(queue.classes), { branch, item }));
}

/** A workspace's class: the highest of its claims', so its card and every check it queues agree. */
export const workspaceClass = (claims: readonly ClaimContext[], make?: MakeProvider): ClassInfo | undefined => highest(claims.map((c) => claimClass(c, make)));
