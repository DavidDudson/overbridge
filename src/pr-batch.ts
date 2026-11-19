import { Cache, errorText } from "./server-cache";
import { isJsonObject, type JsonObject, type JsonValue, numberField, objectField, parseJson, stringField } from "./json";
import { countUnresolved, reviewerStatuses, type ReviewerView } from "./reviewers";
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

/** How long a repo's reply is served when every PR in it is settled (`isSettled`) and each caller's local HEAD matches its PR. */
export const PR_SETTLED_TTL_MS = 3 * 60_000;
export const PR_STALE_MS = 10 * 60_000;

export const PR_FRAGMENT = `fragment F on PullRequest{url title isDraft updatedAt state headRefOid mergeable mergeStateStatus author{login}
labels(first:20){nodes{name}}
reviewRequests(first:20){pageInfo{hasNextPage} nodes{requestedReviewer{__typename ...on User{login} ...on Bot{login} ...on Team{name}}}}
latestReviews(first:20){pageInfo{hasNextPage} nodes{author{login} state submittedAt url}}
comments(last:100){pageInfo{hasPreviousPage} nodes{author{login} body createdAt url}}
reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved comments(first:1){nodes{author{login}}}}}
commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){pageInfo{hasNextPage} nodes{__typename ...on CheckRun{name status conclusion detailsUrl startedAt} ...on StatusContext{context state targetUrl}}}}}}}}`;

/** The aliased query for `numbers` (`p<n>: pullRequest(number:<n>)`), with the call's cost in `rateLimit`. */
export function buildBatchQuery(numbers: number[]): string {
  const aliases = numbers.map((n) => `p${n}:pullRequest(number:${n}){...F}`).join(" ");

  return `query($owner:String!,$name:String!){rateLimit{cost remaining resetAt} repository(owner:$owner,name:$name){${aliases}}} ${PR_FRAGMENT}`;
}

/** The objects in a GraphQL connection's `nodes`; a null node (a deleted user's) is skipped. */
function nodes(connection: JsonValue | undefined): JsonObject[] {
  const list = isJsonObject(connection) ? connection.nodes : undefined;

  return Array.isArray(list) ? list.filter(isJsonObject) : [];
}

type Check = NonNullable<ReviewerView["statusCheckRollup"]>[number];

type ThreadNodes = Parameters<typeof countUnresolved>[0];

const CHECK_KEYS = ["name", "context", "status", "conclusion", "state", "detailsUrl", "targetUrl", "startedAt"] as const;

const check = (node: JsonObject): Check => {
  const out: Check = {};

  for (const key of CHECK_KEYS) {
    const value = stringField(node, key);

    if (value !== undefined) out[key] = value;
  }

  return out;
};

const login = (node: JsonObject): string | undefined => {
  const author = objectField(node, "author");

  return author ? stringField(author, "login") : undefined;
};

const optionalString = (node: JsonObject, key: string): string | undefined => stringField(node, key);

const review = (node: JsonObject): NonNullable<PrView["latestReviews"]>[number] => ({
  author: { login: login(node) },
  state: optionalString(node, "state"),
  submittedAt: optionalString(node, "submittedAt"),
  url: optionalString(node, "url"),
});

const comment = (node: JsonObject): NonNullable<PrView["comments"]>[number] => ({
  author: { login: login(node) },
  body: optionalString(node, "body"),
  createdAt: optionalString(node, "createdAt"),
  url: optionalString(node, "url"),
});

const thread = (node: JsonObject): ThreadNodes[number] => ({
  isResolved: node.isResolved === true,
  comments: { nodes: nodes(node.comments).map((c) => ({ author: { login: login(c) } })) },
});

/** The node `pageInfo` of the connection `name` on `node`, when it says the page was cut short. */
const cutShort = (connection: JsonValue | undefined, flag: "hasNextPage" | "hasPreviousPage"): boolean => {
  const info = isJsonObject(connection) ? objectField(connection, "pageInfo") : undefined;

  return info?.[flag] === true;
};

/** The first commit's check contexts of a reply node. */
const rollup = (node: JsonObject): JsonValue | undefined => {
  const commit = objectField(nodes(node.commits)[0] ?? {}, "commit");
  const status = commit ? objectField(commit, "statusCheckRollup") : undefined;

  return status?.contexts;
};

/** One reply node as `gh pr view --json ...` would have printed that PR. */
export function mapPr(node: JsonObject): PrView {
  const contexts = nodes(rollup(node)).map(check);

  const requested = nodes(node.reviewRequests).flatMap((r) => {
    const reviewer = objectField(r, "requestedReviewer");

    return reviewer ? [reviewer] : [];
  });

  const reviewRequests = requested.flatMap((r) => {
    const out: NonNullable<PrView["reviewRequests"]>[number] = {};
    const loginName = stringField(r, "login");
    const name = stringField(r, "name");

    if (loginName !== undefined) out.login = loginName;

    if (name !== undefined) out.name = name;

    return [out];
  });

  return {
    url: stringField(node, "url"),
    title: stringField(node, "title"),
    isDraft: node.isDraft === true || node.isDraft === false ? node.isDraft : undefined,
    updatedAt: stringField(node, "updatedAt"),
    state: stringField(node, "state"),
    headRefOid: stringField(node, "headRefOid"),
    mergeable: stringField(node, "mergeable"),
    mergeStateStatus: stringField(node, "mergeStateStatus"),
    statusCheckRollup: contexts,
    reviewRequests,
    latestReviews: nodes(node.latestReviews).map(review),
    comments: nodes(node.comments).map(comment),
    unresolved: countUnresolved(nodes(node.reviewThreads).map(thread)),
    labels: nodes(node.labels).flatMap((l) => {
      const name = stringField(l, "name");

      return name === undefined ? [] : [{ name }];
    }),
    ...author(node),
  };
}

/** The PR's author as `gh pr view --json author` gives it, or nothing for a deleted user. */
const author = (node: JsonObject): Pick<PrView, "author"> => {
  const name = login(node);

  return name === undefined ? {} : { author: { login: name } };
};

/**
 * A connection the query cut short: past 100 review threads or check contexts or comments, or 20 reviews or review
 * requests, the counts and the reviewers' state would be short, so the PR is read the per-PR way.
 */
const truncated = (node: JsonObject): boolean =>
  cutShort(node.reviewThreads, "hasNextPage") ||
  cutShort(rollup(node), "hasNextPage") ||
  cutShort(node.comments, "hasPreviousPage") ||
  cutShort(node.latestReviews, "hasNextPage") ||
  cutShort(node.reviewRequests, "hasNextPage");

/** A check still running: a check run not yet completed, or a commit status still pending or expected. */
const pendingCheck = (c: NonNullable<ReviewerView["statusCheckRollup"]>[number]): boolean =>
  c.status !== undefined ? c.status !== "COMPLETED" : c.state === "PENDING" || c.state === "EXPECTED";

/**
 * Whether a PR is waiting on nothing the panel shows changing soon: closed or merged, or open with checks that are all done, its
 * mergeability known and no bot review running. A PR GitHub no longer returns is settled; one the reply cut short is not.
 */
export function isSettled(view: PrView | null | undefined): boolean {
  if (view === null) return true;

  if (view === undefined) return false;

  if (view.state !== "OPEN") return true;

  // no checks yet is how a fresh push looks before CI registers its runs
  const checks = view.statusCheckRollup ?? [];

  if (view.mergeable === "UNKNOWN" || checks.length === 0 || checks.some(pendingCheck)) return false;

  return !reviewerStatuses(view, view.url ?? "").some((r) => r.state === "reviewing");
}

/** The TTL for a repo's reply: longer once every PR in it is settled and no caller's local HEAD is ahead of its PR's head. */
export function ttlFor(held: Record<number, PrView | null | undefined> | undefined, heads: Readonly<Record<number, string>> = {}): number {
  if (held === undefined) return PR_TTL_MS;
  const views = Object.values(held);
  const headsMatch = Object.entries(heads).every(([n, sha]) => held[Number(n)]?.headRefOid === sha);

  return views.length > 0 && views.every(isSettled) && headsMatch ? PR_SETTLED_TTL_MS : PR_TTL_MS;
}

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
  let body: JsonValue;

  try {
    body = parseJson(out);
  } catch {
    throw new Error("GitHub reply was not JSON");
  }

  const root = isJsonObject(body) ? body : {};
  const data = objectField(root, "data");
  const repo = data ? objectField(data, "repository") : undefined;
  const errors = Array.isArray(root.errors) ? root.errors.filter(isJsonObject) : [];

  if (!repo) throw new Error((errors[0] && stringField(errors[0], "message")) || "GitHub reply had no repository");
  // an alias that is null because the PR is gone (NOT_FOUND) is a missing PR; any other error on it (a timeout, a
  // resource limit) fails the call, so a transient fault is not cached for the TTL as a deleted PR
  const failed = errors.find((e) => e.type !== "NOT_FOUND" && /^p\d+$/.test(String(errorAlias(e) ?? "")));

  if (failed) throw new Error(stringField(failed, "message") ?? `GitHub error on ${errorAlias(failed)}`);
  const prs: Record<number, PrView | null | undefined> = {};

  for (const n of numbers) {
    const node = repo[`p${n}`];
    prs[n] = !isJsonObject(node) ? null : truncated(node) ? undefined : mapPr(node);
  }

  const cost = data ? numberField(objectField(data, "rateLimit") ?? {}, "cost") : undefined;
  const reply: BatchReply = { prs };

  if (cost !== undefined) reply.cost = cost;

  return reply;
}

/** The alias a GraphQL error names: `path[1]`, under `repository`. */
const errorAlias = (e: JsonObject): JsonValue | undefined => (Array.isArray(e.path) ? e.path[1] : undefined);

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
  /** Why `gh` is paused (a rate limit), or undefined; a paused fetch fails without calling `gh`. */
  paused?: () => string | undefined;
  perQuery?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onError?: (key: string, e: Error) => void;
}

/**
 * Coalesces PR reads. Every refresh that asks for a PR of `owner/name` within one window shares a single fetch, which
 * reads that repo's claimed PRs together (paged by `perQuery`); each PR is then served from the repo's cache entry for
 * `PR_TTL_MS`, or `PR_SETTLED_TTL_MS` once nothing in it is moving. Keys are `gh:prs:<owner/name>`; each entry holds
 * that repo's PRs by number.
 */
export class PrBatcher {
  private readonly cache: Cache<Record<number, PrView | null | undefined>>;
  private readonly wanted = new Map<string, Set<number>>();
  private readonly counters: PrBatchStats = { calls: 0, prs: 0, points: 0 };
  private readonly run: GhRun;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly windowMs: number;
  private readonly perQuery: number;
  private readonly paused: () => string | undefined;
  private readonly claimed: (repo: string) => number[];

  constructor(o: PrBatcherOptions = {}) {
    this.run = o.run ?? ghRun;
    this.claimed = o.claimed ?? (() => []);
    this.windowMs = o.windowMs ?? BATCH_WINDOW_MS;
    this.paused = o.paused ?? (() => undefined);
    this.perQuery = o.perQuery ?? PRS_PER_QUERY;
    this.sleep = o.sleep ?? ((ms) => Bun.sleep(ms));
    this.cache = new Cache({ maxInFlight: 2, now: o.now, onError: o.onError });
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
  async get(repo: string, numbers: number[], o: { force?: boolean; heads?: Readonly<Record<number, string>> } = {}): Promise<{ prs: Record<number, PrView | null | undefined>; error?: string }> {
    const want = this.wanted.get(repo) ?? new Set<number>();
    this.wanted.set(repo, want);

    for (const n of numbers) want.add(n);
    const key = `gh:prs:${repo}`;
    // paused by a rate limit: serve the last reply without a fetch, so the pause counts as no failure and leaves no backoff behind. A forced read (the user's `r`) goes through.
    const paused = o.force ? undefined : this.paused();

    if (paused) {
      const held = this.cache.peek(key);

      if (held === undefined) throw new Error(paused);

      return { prs: held, error: paused };
    }

    const opts = { ttlMs: ttlFor(this.cache.peek(key), o.heads), staleMs: PR_STALE_MS, force: o.force === true };
    let got = await this.cache.get(key, () => this.fetch(repo), opts);

    // a PR opened since the reply was read is not in it: read again once
    if (numbers.some((n) => !(n in got.value)) && got.served !== "stale") {
      try {
        got = await this.cache.get(key, () => this.fetch(repo), { ...opts, force: true });
      } catch {
        // the first reply still serves every PR it holds
      }
    }

    return got.error ? { prs: got.value, error: got.error } : { prs: got.value };
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
