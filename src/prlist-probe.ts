import { isJsonObject, type JsonObject, type JsonValue, objectField, parseJson, stringField } from "./json";
import type { RunResult } from "./util";

/** A cheap read of each listed PR's URL, update time and CI state: a refresh skips the costly full read while it is unchanged. */

/** The most PRs one search returns: GraphQL's page limit. */
export const MAX_PAGE_SIZE = 100;

/** Extra PRs a full read asks for over the probe's count, for a PR opened between the two calls. */
export const PAGE_HEADROOM = 5;

export const PROBE_QUERY = `query($q:String!){search(query:$q,type:ISSUE,first:${MAX_PAGE_SIZE}){nodes{...on PullRequest{url updatedAt commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}}`;

export interface Probe {
  /** Changes when a PR joins or leaves the list, is updated, or its CI rollup state moves. */
  signature: string;
  /** PRs the search found. */
  count: number;
}

/** The `gh api graphql` command for one probe of search string `q`. */
export const probeCommand = (q: string): string[] => ["gh", "api", "graphql", "-f", `query=${PROBE_QUERY}`, "-f", `q=${q}`];

/** The page size for a full read of a list the probe counted `count` PRs in. */
export const pageSizeFor = (count: number): number => Math.min(MAX_PAGE_SIZE, Math.max(1, count + PAGE_HEADROOM));

const rollupOf = (node: JsonObject): string => {
  const commits = objectField(node, "commits");
  const last = Array.isArray(commits?.nodes) ? commits.nodes[0] : undefined;
  const commit = isJsonObject(last) ? objectField(last, "commit") : undefined;
  const rollup = commit ? objectField(commit, "statusCheckRollup") : undefined;

  return (rollup && stringField(rollup, "state")) ?? "";
};

const firstError = (body: JsonValue): string | undefined => {
  const errors = isJsonObject(body) ? body.errors : undefined;
  const first = Array.isArray(errors) ? errors[0] : undefined;

  return isJsonObject(first) ? stringField(first, "message") : undefined;
};

/** The probe from a reply. A reply with no `data.search` is a failure of the whole call. */
export function parseProbe(out: string): Probe {
  let body: JsonValue;

  try {
    body = parseJson(out);
  } catch {
    throw new Error("GitHub reply was not JSON");
  }

  const data = isJsonObject(body) ? objectField(body, "data") : undefined;
  const nodes = data ? objectField(data, "search")?.nodes : undefined;

  if (!Array.isArray(nodes)) {
    throw new Error(firstError(body) ?? "GitHub reply had no search results");
  }

  const lines = nodes.filter(isJsonObject).flatMap((n) => {
    const url = stringField(n, "url");

    return url === undefined ? [] : [`${url} ${stringField(n, "updatedAt") ?? ""} ${rollupOf(n)}`];
  });

  return { signature: lines.toSorted().join("\n"), count: lines.length };
}

/** Probe search string `q`. Throws with `gh`'s message when the call fails with no data. */
export function readProbe(q: string, runner: (cmd: string[]) => RunResult): Probe {
  const r = runner(probeCommand(q));

  // `gh api graphql` exits 1 when any node errors yet still prints the data, so the body decides
  try {
    return parseProbe(r.stdout);
  } catch (e) {
    if (r.ok) {
      throw e;
    }

    const line = (r.stderr || r.stdout).trim().split("\n")[0];

    throw new Error(`gh api graphql failed: ${line || `exit ${r.code}`}`);
  }
}

/** One signature for several searches (the reviews tab runs one per owner), in the order they ran. */
export const combinedSignature = (probes: readonly Probe[]): string => probes.map((p) => p.signature).join("\n--\n");
