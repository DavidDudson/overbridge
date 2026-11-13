import { getRepo } from "./config";
import type { PrBatcher } from "./pr-batch";
import { localStacks, stackOf } from "./stack";
import { getWorkspace, isIceboxed, readState } from "./state";
import type { PrefetchedPrs } from "./top";
import { errorText } from "./server-cache";

/** `owner/name` of a GitHub remote URL (ssh or https), or undefined for any other host. */
export function ownerRepo(url: string): string | undefined {
  return /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url)?.slice(1, 3).join("/");
}

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

/** Every claimed PR in every workspace, grouped by `owner/name`: what one call per repo reads. */
export function claimedPrs(repoFullName: string): number[] {
  const out = new Set<number>();
  const state = readState();
  const catalogs = new Map<string, ReturnType<typeof localStacks>>();
  const stacks = (repo: string) => catalogs.get(repo) ?? catalogs.set(repo, safeStacks(repo)).get(repo)!;
  for (const ws of Object.keys(state.workspaces)) {
    // an iceboxed workspace has no tab and no panel to draw, so its PRs are not worth the query's points
    if (isIceboxed(state.workspaces[ws])) continue;
    for (const [repo, c] of Object.entries(getWorkspace(state, ws).repos)) {
      if (c.pr !== undefined && repoOf(repo) === repoFullName) for (const n of claimPrs(repo, c.branch, c.pr, stacks(repo))) out.add(n);
    }
  }
  return [...out];
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
