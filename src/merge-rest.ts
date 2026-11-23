import { isJsonObject, isJsonString, type JsonValue } from "./json";

/** One claim as the REST merge check needs it. */
export interface RestClaim {
  branch?: string;
  pr?: number;
}

/**
 * Read one PR through REST (`repos/{owner}/{repo}/pulls/<n>`), which spends the core budget, not GraphQL's. `gh` fills
 * `{owner}/{repo}` from the worktree it runs in.
 */
export const restPrCommand = (n: number): string[] => ["gh", "api", `repos/{owner}/{repo}/pulls/${n}`, "--jq", "{merged_at, head: .head.sha}"];

/** The PR's head commit when the REST reply says it merged; undefined while open, closed unmerged, or when the reply is unreadable. */
export function mergedHead(out: string | undefined): string | undefined {
  if (!out) {
    return undefined;
  }

  let raw: JsonValue;

  try {
    raw = JSON.parse(out);
  } catch {
    return undefined;
  }

  if (!isJsonObject(raw) || !isJsonString(raw.merged_at) || !raw.merged_at || !isJsonString(raw.head) || !raw.head) {
    return undefined;
  }

  return raw.head;
}

/**
 * Each claimed repo's PR head, read through REST, when every claimed branch's PR has merged: the same shape as
 * `TopCache.merged`. Undefined when a claim has no PR, a PR has not merged, or any read fails, so a failed read never
 * makes a workspace look finished.
 */
export function restMergedHeads(claims: Readonly<Record<string, RestClaim>>, dirOf: (repo: string) => string, exec: (cmd: string[], cwd: string) => string | undefined): Record<string, string> | undefined {
  const claimed = Object.entries(claims).filter(([, c]) => c.branch);

  if (!claimed.length || claimed.some(([, c]) => c.pr === undefined)) {
    return undefined;
  }

  const heads = claimed.flatMap(([repo, c]) => {
    const head = mergedHead(exec(restPrCommand(c.pr!), dirOf(repo)));

    return head ? [[repo, head] as const] : [];
  });

  return heads.length === claimed.length ? Object.fromEntries(heads) : undefined;
}
