import { isJsonObject, isJsonString, type JsonValue } from "./json";

/** One claim as the REST merge check needs it. */
export interface RestClaim {
  branch?: string;
  pr?: number;
}

/** Read one PR through REST (`gh` fills `{owner}/{repo}` from the worktree), which spends the core budget, not GraphQL's. */
export const restPrCommand = (prNumber: number): string[] => ["gh", "api", `repos/{owner}/{repo}/pulls/${prNumber}`, "--jq", "{merged_at, head: .head.sha}"];

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

/** Each claimed repo's merged PR head, as `TopCache.merged`; undefined unless every claimed PR merged and every read worked. */
export function restMergedHeads(claims: Readonly<Record<string, RestClaim>>, dirOf: (repo: string) => string, exec: (cmd: string[], cwd: string) => string | undefined): Record<string, string> | undefined {
  const claimed = Object.entries(claims).filter(([, c]) => c.branch);

  if (!claimed.length || claimed.some(([, c]) => c.pr === undefined)) {
    return undefined;
  }

  const heads: Record<string, string> = {};

  // stop at the first PR that has not merged: the answer is known, and every read spends the REST budget
  for (const [repo, c] of claimed) {
    const head = c.pr === undefined ? undefined : mergedHead(exec(restPrCommand(c.pr), dirOf(repo)));

    if (!head) {
      return undefined;
    }

    heads[repo] = head;
  }

  return heads;
}
