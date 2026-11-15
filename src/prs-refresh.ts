import { FRAGMENT, mapPr } from "./pr-batch";
import { ciFromRollup, type CiState } from "./pr-look";
import type { PrRow } from "./pr-rows";
import { reviewerStatuses } from "./reviewers";
import type { RunResult } from "./util";

/**
 * The My PRs list's data: one GraphQL search for the PRs you opened, carrying what the table shows (merge state, checks,
 * review decision, Copilot and CodeRabbit). It reuses the batch fragment, so a PR reads the same here as in a workspace card.
 */

const QUERY = `query($q:String!){search(query:$q,type:ISSUE,first:50){nodes{...on PullRequest{...F number author{login} reviewDecision repository{nameWithOwner}}}}} ${FRAGMENT}`;

/** The search string: your open PRs, narrowed to `orgs` when any are set. */
export const searchQuery = (orgs: readonly string[]): string => ["is:pr", "is:open", "author:@me", ...orgs.map((o) => `user:${o}`), "sort:updated-desc"].join(" ");

/** The `gh api graphql` command for the list. */
export const graphqlCommand = (orgs: readonly string[]): string[] => ["gh", "api", "graphql", "-f", `query=${QUERY}`, "-f", `q=${searchQuery(orgs)}`];

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PENDING = new Set(["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

/** Checks as one state: any failure wins, then any still running; no checks is `none`. */
export function ciOf(checks: readonly { status?: string; conclusion?: string; state?: string }[] | undefined): CiState {
  if (!checks?.length) return "none";

  if (checks.some((c) => FAILED.has(c.conclusion ?? "") || FAILED.has(c.state ?? ""))) return ciFromRollup("FAILURE");

  if (checks.some((c) => PENDING.has(c.status ?? "") && !c.conclusion) || checks.some((c) => PENDING.has(c.state ?? ""))) return ciFromRollup("PENDING");

  return ciFromRollup("SUCCESS");
}

/** Rows from the search reply. A reply with no `data.search` is a failure of the whole call. */
export function rowsFromGraphql(out: string): PrRow[] {
  let body: any;

  try {
    body = JSON.parse(out);
  } catch {
    throw new Error("GitHub reply was not JSON");
  }

  const nodes = body?.data?.search?.nodes;

  if (!Array.isArray(nodes)) throw new Error(body?.errors?.[0]?.message ?? "GitHub reply had no search results");

  return nodes
    .filter((n: any) => n?.url)
    .map((n: any): PrRow => {
      const view = mapPr(n);

      return {
        repo: n.repository?.nameWithOwner ?? "",
        number: n.number,
        title: n.title,
        url: n.url,
        author: n.author?.login ?? "",
        draft: n.isDraft === true,
        updatedAt: n.updatedAt,
        mergeable: n.mergeable,
        ci: ciOf(view.statusCheckRollup),
        decision: n.reviewDecision ?? "",
        bots: reviewerStatuses(view, n.url),
      };
    });
}

/** Read the list. Throws with `gh`'s message when the call fails with no data. */
export function readMyPrs(orgs: readonly string[], runner: (cmd: string[]) => RunResult): PrRow[] {
  const r = runner(graphqlCommand(orgs));

  // `gh api graphql` exits 1 when any node errors yet still prints the data, so the body decides
  try {
    return rowsFromGraphql(r.stdout);
  } catch (e) {
    if (!r.ok && r.stderr.trim()) throw new Error(`gh api graphql failed: ${r.stderr.trim().split("\n")[0]}`);
    throw e;
  }
}
