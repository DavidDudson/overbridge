import { type ClaimFacts, type ClassInfo, classInfo, defaultClassName, highest, priorityOf } from "./check-priority";
import { committedConfig } from "./committed-config";
import { loadRepos } from "./config";
import type { WorkRow } from "./pm/worklist";
import type { CheckQueue } from "./project-config";

/**
 * The work list's second ranking layer: each row's class from the same `priority-classes` and
 * `check-queue.priority-rules` the check queue uses, so one config orders both.
 */

/** The class `queue` gives these facts: its first matching rule, else the repo's `priority`, else the default class. */
export const queueClass = (queue: CheckQueue, facts: ClaimFacts): ClassInfo =>
  classInfo(queue.classes, priorityOf(queue.priorityRules, queue.priority ?? defaultClassName(queue.classes), facts));

/** The repos a row can be started in: its `repos`, else its own repo. */
export const rowRepos = (row: Pick<WorkRow, "repo" | "repos">): readonly string[] => row.repos ?? [row.repo];

/** What the rules see of a row. It has no branch until it is started, so `branch` rules never match one. */
export const rowFacts = (row: Pick<WorkRow, "id" | "type" | "labels">): ClaimFacts => ({ item: row.id, type: row.type, labels: row.labels });

/**
 * A row's class: the highest its repos' rules give, as a workspace with several repos takes its highest claim's.
 * None when no repo's settings are known, so the row ties with every other unknown one.
 */
export const rowClass =
  (queueOf: (repo: string) => CheckQueue | undefined) =>
  (row: WorkRow): ClassInfo | undefined =>
    highest(
      rowRepos(row).flatMap((repo) => {
        const queue = queueOf(repo);

        return queue ? [queueClass(queue, rowFacts(row))] : [];
      }),
    );

/** Every registered repo's check-queue settings, from its committed config. A repo whose config cannot be read is left out. */
export function loadQueues(): ReadonlyMap<string, CheckQueue> {
  return new Map(
    Object.values(loadRepos()).flatMap((spec): [string, CheckQueue][] => {
      try {
        return [[spec.name, committedConfig(spec).checkQueue]];
      } catch {
        // `worklist refresh` already notes a repo whose config does not load
        return [];
      }
    }),
  );
}

/** The facts the work list cache holds for `item` in `repo`, for a claim's rules to match on `type` and `label`. */
export function cachedFacts(rows: readonly WorkRow[], repo: string, item: string): ClaimFacts | undefined {
  const row = rows.find((r) => r.id === item && rowRepos(r).includes(repo));

  return row ? rowFacts(row) : undefined;
}
