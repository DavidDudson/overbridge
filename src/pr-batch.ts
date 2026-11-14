import { Cache, errorText } from "./server-cache";
import { countUnresolved } from "./reviewers";
import type { PrView } from "./top";

/**
 * One GraphQL call per repo for every claimed PR: view, checks, reviewers' reviews and comments, and review threads.
 * It replaces `gh pr view` plus the threads query per workspace. The reply is mapped to `PrView`, the shape
 * `refreshTop` and `classifyPr` already read, so the top cache comes out the same as the per-PR path builds it.
 */

/** PRs per query. Each PR asks for four connections of up to 100 nodes, so a larger repo is paged into several queries. */
export const PRS_PER_QUERY = 20;
export const BATCH_WINDOW_MS = 250;
export const PR_TTL_MS = 60_000;
export const PR_STALE_MS = 10 * 60_000;

const FRAGMENT = `fragment F on PullRequest{url title isDraft updatedAt state headRefOid mergeable mergeStateStatus
reviewRequests(first:20){pageInfo{hasNextPage} nodes{requestedReviewer{__typename ...on User{login} ...on Bot{login} ...on Team{name}}}}
latestReviews(first:20){pageInfo{hasNextPage} nodes{author{login} state submittedAt url}}
comments(last:100){pageInfo{hasPreviousPage} nodes{author{login} body createdAt url}}
reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved comments(first:1){nodes{author{login}}}}}
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ...on CheckRun{name status conclusion detailsUrl} ...on StatusContext{context state targetUrl}}}}}}}}`;

/** The aliased query for `numbers` (`p<n>: pullRequest(number:<n>)`), with the call's cost in `rateLimit`. */
export function buildBatchQuery(numbers: number[]): string {
  const aliases = numbers.map((n) => `p${n}:pullRequest(number:${n}){...F}`).join(" ");
  return `query($owner:String!,$name:String!){rateLimit{cost remaining resetAt} repository(owner:$owner,name:$name){${aliases}}} ${FRAGMENT}`;
}

type Nodes<T> = { nodes?: (T | null)[] } | null | undefined;
const nodes = <T>(c: Nodes<T>): T[] => (c?.nodes ?? []).filter((n): n is T => n != null);

/** One reply node as `gh pr view --json ...` would have printed that PR. */
export function mapPr(node: Record<string, any>): PrView {
  const contexts = nodes<Record<string, any>>(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts).map(({ __typename: _t, ...c }) => c);
  const requests = nodes<{ requestedReviewer?: { login?: string; name?: string } | null }>(node.reviewRequests).flatMap((r) => (r.requestedReviewer ? [r.requestedReviewer] : []));
  return {
    url: node.url,
    title: node.title,
    isDraft: node.isDraft,
    updatedAt: node.updatedAt,
    state: node.state,
    headRefOid: node.headRefOid,
    mergeable: node.mergeable,
    mergeStateStatus: node.mergeStateStatus,
    statusCheckRollup: contexts,
    reviewRequests: requests.map(({ login, name }) => ({ ...(login !== undefined ? { login } : {}), ...(name !== undefined ? { name } : {}) })),
    latestReviews: nodes(node.latestReviews),
    comments: nodes(node.comments),
    unresolved: countUnresolved(nodes(node.reviewThreads)),
  } as PrView;
}

/**
 * A connection the query cut short: past 100 review threads or check contexts or comments, or 20 reviews or review
 * requests, the counts and the reviewers' state would be short, so the PR is read the per-PR way.
 */
const truncated = (node: Record<string, any>): boolean =>
  node.reviewThreads?.pageInfo?.hasNextPage === true ||
  node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.pageInfo?.hasNextPage === true ||
  node.comments?.pageInfo?.hasPreviousPage === true ||
  node.latestReviews?.pageInfo?.hasNextPage === true ||
  node.reviewRequests?.pageInfo?.hasNextPage === true;

export interface BatchReply {
  /** Each requested PR; null when GitHub has no such PR or the user cannot see it, undefined when the reply cut its threads or checks short (read it directly). */
  prs: Record<number, PrView | null | undefined>;
  cost?: number;
}

/**
 * Read a reply. `gh api graphql` exits 1 when any alias errors (a deleted PR) yet still prints the data, so the body
 * is read whatever the exit code; a reply with no data is a failure of the whole call.
 */
export function parseBatch(out: string, numbers: number[]): BatchReply {
  let body: any;
  try {
    body = JSON.parse(out);
  } catch {
    throw new Error("GitHub reply was not JSON");
  }
  const repo = body?.data?.repository;
  if (!repo) throw new Error(body?.errors?.[0]?.message ?? "GitHub reply had no repository");
  // an alias that is null because the PR is gone (NOT_FOUND) is a missing PR; any other error on it (a timeout, a
  // resource limit) fails the call, so a transient fault is not cached for the TTL as a deleted PR
  const failed = (body.errors ?? []).find((e: any) => e?.type !== "NOT_FOUND" && /^p\d+$/.test(String(e?.path?.[1] ?? "")));
  if (failed) throw new Error(failed.message ?? `GitHub error on ${failed.path?.[1]}`);
  const prs: Record<number, PrView | null | undefined> = {};
  for (const n of numbers) {
    const node = repo[`p${n}`];
    prs[n] = !node ? null : truncated(node) ? undefined : mapPr(node);
  }
  const cost = body?.data?.rateLimit?.cost;
  return { prs, ...(typeof cost === "number" ? { cost } : {}) };
}

/** Runs `gh` with these args; resolves its stdout whatever the exit code, rejects when it cannot run. */
export type GhRun = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number }>;

export const ghRun: GhRun = async (args) => {
  const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    p.kill();
  }, 30_000);
  try {
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    if (timedOut) throw new Error("gh api graphql timed out after 30s");
    return { stdout, stderr, code };
  } finally {
    clearTimeout(timer);
  }
};

export interface PrBatchStats {
  /** `gh` calls made. */
  calls: number;
  /** PRs those calls asked for. */
  prs: number;
  /** GraphQL points the calls cost, as GitHub reported them. */
  points: number;
}

export interface PrBatcherOptions {
  run?: GhRun;
  /** Every PR claimed in `repo` (`owner/name`), which a call fetches along with the ones asked for: one call fills the repo. */
  claimed?: (repo: string) => number[];
  windowMs?: number;
  perQuery?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onError?: (key: string, e: Error) => void;
}

/**
 * Coalesces PR reads. Every refresh that asks for a PR of `owner/name` within one window shares a single fetch, which
 * reads that repo's claimed PRs together (paged by `perQuery`); each PR is then served from the repo's cache entry for
 * `PR_TTL_MS`. Keys are `gh:prs:<owner/name>`; the per-PR keys of the design are the entry's fields.
 */
export class PrBatcher {
  private readonly cache: Cache<Record<number, PrView | null | undefined>>;
  private readonly wanted = new Map<string, Set<number>>();
  private readonly counters: PrBatchStats = { calls: 0, prs: 0, points: 0 };
  private readonly run: GhRun;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly windowMs: number;
  private readonly perQuery: number;
  private readonly claimed: (repo: string) => number[];

  constructor(o: PrBatcherOptions = {}) {
    this.run = o.run ?? ghRun;
    this.claimed = o.claimed ?? (() => []);
    this.windowMs = o.windowMs ?? BATCH_WINDOW_MS;
    this.perQuery = o.perQuery ?? PRS_PER_QUERY;
    this.sleep = o.sleep ?? ((ms) => Bun.sleep(ms));
    this.cache = new Cache({ maxInFlight: 2, ...(o.now ? { now: o.now } : {}), ...(o.onError ? { onError: o.onError } : {}) });
  }

  stats(): PrBatchStats & { cache: ReturnType<Cache<unknown>["stats"]> } {
    return { ...this.counters, cache: this.cache.stats() };
  }

  get busy(): boolean {
    return this.cache.busy;
  }

  /**
   * The views of `numbers` in `repo`. A PR GitHub does not return is `null`. Rejects when the call failed and no
   * earlier reply exists; with one, serves it (stale) and reports the failure in `error`.
   */
  async get(repo: string, numbers: number[], o: { force?: boolean } = {}): Promise<{ prs: Record<number, PrView | null | undefined>; error?: string }> {
    const want = this.wanted.get(repo) ?? new Set<number>();
    this.wanted.set(repo, want);
    for (const n of numbers) want.add(n);
    const key = `gh:prs:${repo}`;
    const opts = { ttlMs: PR_TTL_MS, staleMs: PR_STALE_MS, force: o.force === true };
    let got = await this.cache.get(key, () => this.fetch(repo), opts);
    // a PR opened since the reply was read is not in it: read again once
    if (numbers.some((n) => !(n in got.value)) && got.served !== "stale") {
      try {
        got = await this.cache.get(key, () => this.fetch(repo), { ...opts, force: true });
      } catch {
        // the first reply still serves every PR it holds
      }
    }
    return { prs: got.value, ...(got.error ? { error: got.error } : {}) };
  }

  private async fetch(repo: string): Promise<Record<number, PrView | null | undefined>> {
    // the window: refreshes that start together all add their PRs before the one call reads the set
    await this.sleep(this.windowMs);
    const [owner, name] = repo.split("/");
    const all = [...new Set([...(this.wanted.get(repo) ?? []), ...this.claimed(repo)])].sort((a, b) => a - b);
    this.wanted.delete(repo);
    const out: Record<number, PrView | null | undefined> = {};
    for (let i = 0; i < all.length; i += this.perQuery) {
      const page = all.slice(i, i + this.perQuery);
      const r = await this.run(["api", "graphql", "-f", `query=${buildBatchQuery(page)}`, "-f", `owner=${owner}`, "-f", `name=${name}`]);
      this.counters.calls++;
      this.counters.prs += page.length;
      let reply: BatchReply;
      try {
        reply = parseBatch(r.stdout, page);
      } catch (e) {
        throw new Error(`${errorText(e)}${r.stderr ? `: ${r.stderr.trim().split("\n")[0]}` : ""}`);
      }
      this.counters.points += reply.cost ?? 0;
      Object.assign(out, reply.prs);
    }
    return out;
  }
}
