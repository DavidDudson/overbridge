import { isJsonObject, parseJson, stringField } from "./json";
import type { ReviewerView } from "./reviewers";
import type { PrView } from "./top";

/**
 * `overbridge pr-checks`: a PR's checks as `gh pr checks --json name,state,bucket,link` prints them, read from the server's
 * shared PR batch instead of GitHub. An agent waiting on CI polls this, so ten agents polling cost one batched read per
 * repo per TTL, not one GraphQL call each per poll.
 */

/** `gh pr checks`'s buckets. */
export const CheckBucket = { Pass: "pass", Fail: "fail", Pending: "pending", Skipping: "skipping", Cancel: "cancel" } as const;

export type CheckBucket = (typeof CheckBucket)[keyof typeof CheckBucket];

export interface CheckRow {
  name: string;
  state: string;
  bucket: CheckBucket;
  link: string;
}

const FAIL_STATES: ReadonlySet<string> = new Set(["FAILURE", "ERROR", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);
const SKIP_STATES: ReadonlySet<string> = new Set(["SKIPPED", "NEUTRAL"]);

/** A check's state in `gh pr checks`'s bucket: anything not finished is pending. */
export function bucketOf(state: string): CheckBucket {
  if (state === "SUCCESS") return CheckBucket.Pass;

  if (SKIP_STATES.has(state)) return CheckBucket.Skipping;

  if (FAIL_STATES.has(state)) return CheckBucket.Fail;

  return state === "CANCELLED" ? CheckBucket.Cancel : CheckBucket.Pending;
}

type Context = NonNullable<ReviewerView["statusCheckRollup"]>[number];

/** One rollup context as a row: a check run's conclusion once it has one, else its status; a commit status's state. */
const rowOf = (c: Context): CheckRow => {
  const state = c.status === undefined ? (c.state ?? "PENDING") : c.status === "COMPLETED" ? (c.conclusion ?? "COMPLETED") : c.status;

  return { name: c.name ?? c.context ?? "", state, bucket: bucketOf(state), link: c.detailsUrl ?? c.targetUrl ?? "" };
};

/** One row per check name, the newest run kept, as `gh pr checks` does: a re-run leaves the failed run in the rollup too. */
export const newestPerName = (contexts: readonly Context[]): Context[] =>
  [
    ...contexts
      .reduce((byName, c) => {
        const name = c.name ?? c.context ?? "";
        const kept = byName.get(name);

        return kept && (kept.startedAt ?? "") > (c.startedAt ?? "") ? byName : new Map(byName).set(name, c);
      }, new Map<string, Context>())
      .values(),
  ];

export interface ChecksReport {
  rows: CheckRow[];
  /** Why the rows may be out of date, for stderr. */
  notes: string[];
}

/**
 * The rows to print for `view`. While GitHub's head for the PR is not `localHead` (a push not read yet, or commits not
 * pushed), a pending row says so, so a poll that waits for no pending rows keeps waiting instead of reading the old
 * commit's checks as this one's.
 */
export function checksReport(view: PrView, localHead?: string): ChecksReport {
  const rows = newestPerName(view.statusCheckRollup ?? []).map(rowOf);
  const notes: string[] = [];

  if (localHead !== undefined && view.headRefOid !== undefined && view.headRefOid !== localHead) {
    const name = `GitHub's head ${view.headRefOid.slice(0, 7)} is not local HEAD ${localHead.slice(0, 7)}: push it, or wait for the next read`;
    rows.push({ name, state: "PENDING", bucket: CheckBucket.Pending, link: view.url ?? "" });
    notes.push(name);
  }

  return { rows, notes };
}

/** What the server's `GET /pr-checks` answers: the PR's view (null when GitHub has no such PR) and why it may be stale. */
export interface ServedView {
  view?: PrView | null;
  error?: string;
}

/** The server's reply body, or undefined when it is not one. */
export function parseServedView(body: string): ServedView | undefined {
  try {
    const reply = parseJson(body);

    if (!isJsonObject(reply)) return undefined;
    const out: ServedView = {};
    const error = stringField(reply, "error");

    if (error !== undefined) out.error = error;

    if (isJsonObject(reply.view)) {
      // SAFETY: the server sends the batch's `PrView` as it holds it; every field is optional
      out.view = reply.view as PrView;
    } else if (reply.view === null) {
      out.view = null;
    }

    return out;
  } catch {
    return undefined;
  }
}

/** The server's answer to `GET /pr-checks`, or undefined when no server could answer. */
export type ServedReply = { status: number; body: string } | undefined;

/** What `prChecks` reads and calls, injected so tests need no server, git or `gh`. */
export interface PrChecksDeps {
  /** The server's reply for `repo` (`owner/name`) PR `pr`; `head` is the caller's local HEAD, which keeps the batch on its short TTL until GitHub has it. */
  served: (repo: string, pr: number, head?: string) => Promise<ServedReply>;
  /** Run `gh pr checks` in `dir` the usual way: the fallback with no server. Resolves its exit code. */
  ghChecks: (pr: number, dir: string) => number;
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface PrChecksTarget {
  /** `owner/name`. */
  slug: string;
  pr: number;
  dir: string;
  /** The local HEAD, when the PR is the one this worktree's branch holds. */
  head?: string;
}

/** Print `target`'s checks; resolves the exit code: 0 with rows, 1 when there are none or the read failed. */
export async function prChecks(target: PrChecksTarget, deps: PrChecksDeps): Promise<number> {
  // a PR this worktree does not hold has no local HEAD to tell a stale read from a fresh one, so GitHub is read directly
  if (target.head === undefined) return deps.ghChecks(target.pr, target.dir);
  const r = await deps.served(target.slug, target.pr, target.head);

  if (r === undefined) return deps.ghChecks(target.pr, target.dir);
  const reply = parseServedView(r.body);

  // a PR the batch cut short (too many checks or threads) comes back with no view: read it the usual way
  if (r.status === 200 && reply !== undefined && reply.view === undefined && reply.error === undefined) return deps.ghChecks(target.pr, target.dir);

  if (r.status !== 200 || reply === undefined || reply.view === undefined) {
    deps.err(`overbridge pr-checks: reading ${target.slug}#${target.pr} failed: ${reply === undefined ? `server answered ${r.status} with a body that is not JSON` : (reply.error ?? `server answered ${r.status}`)}`);

    return 1;
  }

  if (reply.view === null) {
    deps.err(`overbridge pr-checks: GitHub has no PR ${target.slug}#${target.pr}, or this account cannot see it`);

    return 1;
  }

  const { rows, notes } = checksReport(reply.view, target.head);

  for (const note of reply.error ? [`served from cache: ${reply.error}`, ...notes] : notes) deps.err(note);

  if (rows.length === 0) {
    deps.err(`overbridge pr-checks: no checks reported on ${target.slug}#${target.pr} yet`);

    return 1;
  }

  deps.out(`${JSON.stringify(rows)}\n`);

  return 0;
}
