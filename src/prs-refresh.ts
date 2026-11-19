import { isJsonObject, type JsonObject, type JsonValue, numberField, objectField, parseJson, stringField } from "./json";
import { mapPr, PR_FRAGMENT } from "./pr-batch";
import { MAX_PAGE } from "./prlist-probe";
import { ciFromRollup } from "./pr-look";
import type { PrRow } from "./pr-rows";
import { reviewerStatuses } from "./reviewers";
import { stripControl } from "./term";
import type { RunResult } from "./util";

// Reuses the batch fragment, so a PR reads the same here as in a workspace card.

/** The search for up to `page` PRs: GitHub charges about a point per PR asked for, so callers size it to the list. */
const query = (page: number) => `query($q:String!){search(query:$q,type:ISSUE,first:${page}){nodes{...on PullRequest{...F number author{login} reviewDecision repository{nameWithOwner} commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}} ${PR_FRAGMENT}`;

/** The search string: your open PRs, narrowed to `orgs` when any are set. */
export const searchQuery = (orgs: readonly string[]): string => ["is:pr", "is:open", "author:@me", ...orgs.map((o) => `user:${o}`), "sort:updated-desc"].join(" ");

/** The `gh api graphql` command for the list, asking for up to `page` PRs. */
export const graphqlCommand = (orgs: readonly string[], page = MAX_PAGE): string[] => ["gh", "api", "graphql", "-f", `query=${query(page)}`, "-f", `q=${searchQuery(orgs)}`];

/** GitHub's own rollup state for the PR's last commit, so it matches the Reviews tab and counts every check. */
function rollupState(node: JsonObject): string | undefined {
  const commits = objectField(node, "commits");
  const last = Array.isArray(commits?.nodes) ? commits.nodes[0] : undefined;
  const commit = isJsonObject(last) ? objectField(last, "commit") : undefined;
  const rollup = commit ? objectField(commit, "statusCheckRollup") : undefined;

  return rollup ? stringField(rollup, "state") : undefined;
}

/** The first error GitHub reported, if any. */
function firstError(body: JsonValue): string | undefined {
  const errors = isJsonObject(body) ? body.errors : undefined;
  const first = Array.isArray(errors) ? errors[0] : undefined;

  return isJsonObject(first) ? stringField(first, "message") : undefined;
}

/** One search node as a row; a node with no URL (GitHub returned it null or as another type) has none. */
function rowOf(node: JsonObject): PrRow[] {
  const url = stringField(node, "url");
  const number = numberField(node, "number");

  if (url === undefined || number === undefined) return [];

  const view = mapPr(node);

  const row: PrRow = {
    repo: stripControl(stringField(objectField(node, "repository") ?? {}, "nameWithOwner") ?? ""),
    number,
    title: stripControl(stringField(node, "title") ?? ""),
    url,
    author: stripControl(stringField(objectField(node, "author") ?? {}, "login") ?? ""),
    draft: node.isDraft === true,
    updatedAt: stringField(node, "updatedAt") ?? "",
    ci: ciFromRollup(rollupState(node)),
    decision: stringField(node, "reviewDecision") ?? "",
    bots: reviewerStatuses(view, url),
  };

  const mergeable = stringField(node, "mergeable");

  if (mergeable !== undefined) row.mergeable = mergeable;

  return [row];
}

/** Rows from the search reply. A reply with no `data.search` is a failure of the whole call. */
export function rowsFromGraphql(out: string): PrRow[] {
  let body: JsonValue;

  try {
    body = parseJson(out);
  } catch {
    throw new Error("GitHub reply was not JSON");
  }

  const data = isJsonObject(body) ? objectField(body, "data") : undefined;
  const nodes = data ? objectField(data, "search")?.nodes : undefined;

  if (!Array.isArray(nodes)) throw new Error(firstError(body) ?? "GitHub reply had no search results");

  return nodes.filter((n): n is JsonObject => isJsonObject(n)).flatMap(rowOf);
}

/** Read up to `page` PRs of the list. Throws with `gh`'s message when the call fails with no data. */
export function readMyPrs(orgs: readonly string[], runner: (cmd: string[]) => RunResult, page = MAX_PAGE): PrRow[] {
  const r = runner(graphqlCommand(orgs, page));

  // `gh api graphql` exits 1 when any node errors yet still prints the data, so the body decides
  try {
    return rowsFromGraphql(r.stdout);
  } catch (e) {
    if (r.ok) throw e;
    const line = (r.stderr || r.stdout).trim().split("\n")[0];

    throw new Error(`gh api graphql failed: ${line || `exit ${r.code}`}`);
  }
}
