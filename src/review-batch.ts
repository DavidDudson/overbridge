import { isNumber } from "./util";
import { ciFromRollup } from "./pr-look";
import type { PrRow } from "./pr-rows";
import { reviewerStatuses, type ReviewerView, countUnresolved } from "./reviewers";

/**
 * The reviews asked of me, in one GraphQL search per owner: who each request names (me or a team of mine),
 * and what Copilot, CodeRabbit, CI and merge state say about the PR. `review-requested:<me>` matches a request
 * to me and to a team I belong to, so `reviewRequests` is what tells the two apart.
 */
const PR_FIELDS = `
  number title url isDraft updatedAt mergeable reviewDecision
  author { login }
  repository { nameWithOwner }
  reviewRequests(first: 20) { nodes { requestedReviewer {
    __typename
    ... on User { login }
    ... on Bot { login }
    ... on Team { slug organization { login } }
  } } }
  latestReviews(first: 20) { nodes { author { login } state submittedAt url } }
  comments(last: 30) { nodes { author { login } body createdAt url } }
  reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login } } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state
    contexts(first: 50) { nodes {
      __typename
      ... on CheckRun { name status conclusion detailsUrl }
      ... on StatusContext { context state targetUrl }
    } }
  } } } }`;

export const REVIEW_QUERY = `query($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ... on PullRequest {${PR_FIELDS} } } } }`;

/** The search string: open PRs I am asked to review, in `org` when given. */
export const searchString = (login: string, org?: string): string => `is:pr is:open archived:false review-requested:${login}${org ? ` org:${org}` : ""} sort:updated-desc`;

/** The `gh api graphql` command for one search. */
export const reviewCommand = (login: string, org?: string): string[] => ["gh", "api", "graphql", "-f", `query=${REVIEW_QUERY}`, "-f", `q=${searchString(login, org)}`];

interface Reviewer {
  __typename?: string;
  login?: string;
  slug?: string;
  organization?: { login?: string };
}

interface Context {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export interface Node {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  mergeable?: string;
  reviewDecision?: string | null;
  author?: { login?: string } | null;
  repository: { nameWithOwner: string };
  reviewRequests?: { nodes?: { requestedReviewer?: Reviewer | null }[] };
  latestReviews?: { nodes?: { author?: { login?: string }; state?: string; submittedAt?: string; url?: string }[] };
  comments?: { nodes?: { author?: { login?: string }; body?: string; createdAt?: string; url?: string }[] };
  reviewThreads?: { nodes?: Parameters<typeof countUnresolved>[0] };
  commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string; contexts?: { nodes?: Context[] } } | null } }[] };
}

export interface Requested {
  direct: boolean;
  teams: string[];
}

/** Whether `me` is named directly, and the teams (`org/slug`) that are. */
export function requestedOf(node: Node, me: string): Requested {
  const reviewers = (node.reviewRequests?.nodes ?? []).flatMap((n) => (n.requestedReviewer ? [n.requestedReviewer] : []));

  const direct = reviewers.some((r) => r.login?.toLowerCase() === me.toLowerCase());
  const teams = reviewers.flatMap((r) => (r.slug ? [`${r.organization?.login ?? ""}/${r.slug}`.replace(/^\//, "")] : []));

  return { direct, teams };
}

/** One search result as a row. */
export function rowFromNode(node: Node, me: string): PrRow {
  const requested = requestedOf(node, me);
  const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;

  const view: ReviewerView = {
    reviewRequests: (node.reviewRequests?.nodes ?? []).flatMap((n) => (n.requestedReviewer?.login ? [{ login: n.requestedReviewer.login }] : [])),
    latestReviews: node.latestReviews?.nodes ?? [],
    comments: node.comments?.nodes ?? [],
    statusCheckRollup: rollup?.contexts?.nodes ?? [],
    unresolved: countUnresolved(node.reviewThreads?.nodes ?? []),
  };

  const direct = requested.direct || requested.teams.length === 0;

  const row: PrRow = {
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author?.login ?? "",
    draft: node.isDraft,
    updatedAt: node.updatedAt,
    ci: ciFromRollup(rollup?.state),
    bots: reviewerStatuses(view, node.url),
    group: direct ? "direct" : "team",
  };

  if (node.mergeable) row.mergeable = node.mergeable;

  if (node.reviewDecision) row.decision = node.reviewDecision;

  if (!direct) row.via = requested.teams.join(", ");

  return row;
}

/** Whether a search result is a pull request with what a row needs; other result kinds come back empty. */
const isNode = (n: Partial<Node>): n is Node => isNumber(n.number) && !!n.repository;

/** Rows from one `gh api graphql` response; a PR found by two searches is kept once by `mergeRows`. */
export function rowsFromReviews(json: string, me: string): PrRow[] {
  // SAFETY: the shape `REVIEW_QUERY` asks for; each node is checked for its number and repository before it is read
  const nodes: Partial<Node>[] = JSON.parse(json)?.data?.search?.nodes ?? [];

  const rows: PrRow[] = [];

  for (const n of nodes) {
    if (isNode(n)) rows.push(rowFromNode(n, me));
  }

  return rows;
}

/** Rows deduplicated by URL (a PR in two owners' searches), newest update first. */
export const mergeRows = (lists: PrRow[][]): PrRow[] =>
  [...new Map(lists.flat().map((r) => [r.url, r])).values()].toSorted((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

/** Keep only rows in `orgs` (`owner/name`); no orgs means every owner. */
export const filterOrgs = (rows: readonly PrRow[], orgs: readonly string[]): PrRow[] =>
  orgs.length === 0 ? [...rows] : rows.filter((r) => orgs.some((o) => r.repo.toLowerCase().startsWith(`${o.toLowerCase()}/`)));
