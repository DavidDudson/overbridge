import { getRepo } from "./config";
import { ownerRepo } from "./repo-slug";
import type { PrBatcher } from "./pr-batch";
import { localStacks, stackOf } from "./stack";
import { getWorkspace, isIceboxed, readState } from "./state";
import type { PrefetchedPrs } from "./top";
import { errorText } from "./server-cache";

export { ownerRepo };

const safeStacks = (repo: string) => {
  try {
    return localStacks(repo);
  } catch {
    return [];
  }
};

/** Every PR a workspace's claim names, with the other layers of its stack: what `refreshTop` reads for `claim`. */
function claimPrs(repo: string, branch: string | undefined, pr: number, stacks: ReturnType<typeof localStacks> = safeStacks(repo)): number[] {
  const layers = stackOf(stacks, branch)?.layers ?? [];
  const prs = layers.flatMap((l) => (l.pr === undefined ? [] : [l.pr]));
  return [...new Set([pr, ...(prs.length > 1 && prs.includes(pr) ? prs : [])])];
}

function repoOf(repo: string): string | undefined {
  try {
    return ownerRepo(getRepo(repo).url);
  } catch {
    return undefined;
  }
}

/** Every claimed PR in every workspace, by `owner/name`: what one call per repo reads. */
function claimedByRepo(): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  const state = readState();
  const catalogs = new Map<string, ReturnType<typeof localStacks>>();
  const stacks = (repo: string) => catalogs.get(repo) ?? catalogs.set(repo, safeStacks(repo)).get(repo)!;
  for (const ws of Object.keys(state.workspaces)) {
    // an iceboxed workspace has no tab and no panel to draw, so its PRs are not worth the query's points
    if (isIceboxed(state.workspaces[ws])) continue;
    for (const [repo, c] of Object.entries(getWorkspace(state, ws).repos)) {
      const full = c.pr === undefined ? undefined : repoOf(repo);
      if (full === undefined || c.pr === undefined) continue;
      const set = out.get(full) ?? out.set(full, new Set()).get(full)!;
      for (const n of claimPrs(repo, c.branch, c.pr, stacks(repo))) set.add(n);
    }
  }
  return out;
}

/** Every claimed PR in `repoFullName`, read fresh from state. */
export const claimedPrs = (repoFullName: string): number[] => [...(claimedByRepo().get(repoFullName) ?? [])];

/**
 * `claimedPrs` that reads state and the stack catalogs once per `ttlMs` for every repo together. The server's batcher asks
 * once per repo per window on its main thread, so this keeps that blocking work to one pass however many repos there are.
 */
export function cachedClaimedPrs(ttlMs: number, now: () => number = Date.now): (repoFullName: string) => number[] {
  let at = -Infinity;
  let all = new Map<string, Set<number>>();
  return (repoFullName) => {
    if (now() - at >= ttlMs) {
      all = claimedByRepo();
      at = now();
    }
    return [...(all.get(repoFullName) ?? [])];
  };
}

/**
 * The PR views `ws` needs, from the batcher: one `gh` call per repo however many workspaces ask. A repo whose remote is
 * not GitHub is left out, so `refreshTop` reads it as it does today; a failed call is carried as that repo's error.
 */
export async function prefetchFor(ws: string, batcher: PrBatcher, o: { force?: boolean } = {}): Promise<PrefetchedPrs> {
  const out: PrefetchedPrs = {};
  const claims = Object.entries(getWorkspace(readState(), ws).repos);
  await Promise.all(
    claims.map(async ([repo, c]) => {
      const full = repoOf(repo);
      if (!full || c.pr === undefined) return;
      try {
        const { prs, error } = await batcher.get(full, claimPrs(repo, c.branch, c.pr), o);
        out[repo] = { prs, ...(error ? { error } : {}) };
      } catch (e) {
        out[repo] = { error: errorText(e) };
      }
    }),
  );
  return out;
}
