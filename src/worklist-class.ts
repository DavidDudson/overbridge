import { type ClaimFacts, type ClassInfo, highest, queueClass } from "./check-priority";
import { committedConfig } from "./committed-config";
import { loadRepos } from "./config";
import { rowRepos, type WorkRow } from "./pm/worklist";
import type { CheckQueue } from "./project-config";
import type { FactsOf } from "./workspace-class";
import { readWorklist } from "./worklist-data";

/**
 * The work list's second ranking layer: each row's class from the same `priority-classes` and
 * `check-queue.priority-rules` the check queue uses, so one config orders both.
 */

/** What the rules see of a row. It has no branch until it is started, so `branch` rules never match one. */
export const rowFacts = (row: Pick<WorkRow, "id" | "type" | "labels">): ClaimFacts => ({ item: row.id, type: row.type, labels: row.labels });

/**
 * A classifier for rows: each row's class is the highest its repos' rules give, as a workspace with several repos
 * takes its highest claim's. None when no repo's settings are known, so the row ties with every other unknown one.
 */
export const rowClassOf =
  (queueOf: (repo: string) => CheckQueue | undefined) =>
  (row: WorkRow): ClassInfo | undefined =>
    highest(
      rowRepos(row).flatMap((repo) => {
        const queue = queueOf(repo);

        return queue ? [queueClass(queue, rowFacts(row))] : [];
      }),
    );

/** The check-queue settings of the registered repos in `names`, from each one's committed config. */
export function loadQueues(names: ReadonlySet<string>): ReadonlyMap<string, CheckQueue> {
  return new Map(
    Object.values(loadRepos())
      .filter((spec) => names.has(spec.name))
      .flatMap((spec): [string, CheckQueue][] => {
        try {
          return [[spec.name, committedConfig(spec).checkQueue]];
        } catch {
          // a repo whose config does not load has no queue, so its rows get no class
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

/** A claim's item facts from the work list cache. */
export const worklistFacts: FactsOf = (repo, item) => cachedFacts(readWorklist().rows, repo, item);
