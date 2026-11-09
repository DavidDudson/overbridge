/**
 * What the automated reviewers (Copilot, CodeRabbit) have done on a PR, read from `gh pr view` JSON.
 * Pass/fail/running is not enough for these: a reviewer out of quota never starts, and that looks
 * different from a review that has not landed yet.
 */

export const REVIEWER_STATES = ["reviewing", "reviewed", "changes", "comments", "limited", "skipped", "failed", "none"] as const;
export type ReviewerState = (typeof REVIEWER_STATES)[number];

export interface ReviewerStatus {
  name: "Copilot" | "CodeRabbit";
  state: ReviewerState;
  /** Short extra text, e.g. how long until a rate-limited reviewer is back: `56m`. */
  detail?: string;
  /** Where clicking should go; the PR when the reviewer has no page of its own. */
  url?: string;
}

/** The slice of `gh pr view --json reviewRequests,latestReviews,comments,statusCheckRollup` read here. */
export interface ReviewerView {
  reviewRequests?: { login?: string; name?: string }[];
  latestReviews?: { author?: { login?: string }; state?: string; submittedAt?: string; url?: string }[];
  comments?: { author?: { login?: string }; body?: string; createdAt?: string; url?: string }[];
  statusCheckRollup?: { name?: string; context?: string; status?: string; conclusion?: string; state?: string; detailsUrl?: string; targetUrl?: string }[];
  /** Unresolved review threads each reviewer opened, from `threadsCommand`. */
  unresolved?: Partial<Record<"Copilot" | "CodeRabbit", number>>;
}

const COPILOT = /copilot/i;
const CODERABBIT = /coderabbit/i;
const RATE_LIMITED = "rate limited by coderabbit.ai";

/** `56 minutes` to `56m`, `1 hour 2 minutes` to `1h 2m`. */
export const shortDuration = (text: string): string =>
  text
    .replace(/(\d+)\s*days?/gi, "$1d")
    .replace(/(\d+)\s*hours?/gi, "$1h")
    .replace(/(\d+)\s*minutes?/gi, "$1m")
    .replace(/(\d+)\s*seconds?/gi, "$1s")
    .replace(/\s+and\s+/gi, " ")
    .trim();

/**
 * Copilot has no check of its own, so its state is its review: landed (reviewed or changes requested),
 * requested and pending (reviewing), or neither. Neither is what a PR looks like when the request was
 * never made, the repo has no Copilot review, or the account is out of premium requests: GitHub accepts
 * the request and silently does nothing, so these cannot be told apart.
 */
function copilot(view: ReviewerView, pr: string): ReviewerStatus {
  const review = view.latestReviews?.find((r) => COPILOT.test(r.author?.login ?? ""));
  if (review) return { name: "Copilot", state: review.state === "CHANGES_REQUESTED" ? "changes" : "reviewed", url: review.url ?? pr };
  if (view.reviewRequests?.some((r) => COPILOT.test(`${r.login ?? ""} ${r.name ?? ""}`))) return { name: "Copilot", state: "reviewing", url: pr };
  return { name: "Copilot", state: "none", url: pr };
}

/**
 * CodeRabbit reports through a check and a summary comment. A comment carrying its rate-limit marker
 * newer than its last review means it is out of quota (the comment says when it is back); otherwise the
 * check says whether it is running, skipped (draft, ignored branch) or done.
 */
function codeRabbit(view: ReviewerView, pr: string): ReviewerStatus {
  const comments = (view.comments ?? []).filter((c) => CODERABBIT.test(c.author?.login ?? ""));
  const review = view.latestReviews?.find((r) => CODERABBIT.test(r.author?.login ?? ""));
  const limit = comments.filter((c) => c.body?.includes(RATE_LIMITED)).at(-1);
  if (limit && (!review?.submittedAt || (limit.createdAt ?? "") > review.submittedAt)) {
    const wait = /available in\s+([^*\n.]+?)\.?\s*\*\*/i.exec(limit.body ?? "")?.[1];
    return { name: "CodeRabbit", state: "limited", ...(wait ? { detail: shortDuration(wait) } : {}), url: limit.url ?? pr };
  }
  const check = view.statusCheckRollup?.find((c) => CODERABBIT.test(c.name ?? c.context ?? ""));
  const url = check?.detailsUrl ?? check?.targetUrl ?? pr;
  if (review) return { name: "CodeRabbit", state: review.state === "CHANGES_REQUESTED" ? "changes" : "reviewed", url: review.url ?? url };
  if (!check) return { name: "CodeRabbit", state: "none", url: pr };
  const outcome = check.conclusion || check.state || check.status || "";
  if (["SUCCESS", "PASSED"].includes(outcome)) return { name: "CodeRabbit", state: "reviewed", url };
  if (["NEUTRAL", "SKIPPED"].includes(outcome)) return { name: "CodeRabbit", state: "skipped", url };
  if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"].includes(outcome)) return { name: "CodeRabbit", state: "failed", url };
  return { name: "CodeRabbit", state: "reviewing", url };
}

/** Both reviewers' statuses for a PR at `pr` (its URL). CodeRabbit is left out when the repo never uses it. */
export function reviewerStatuses(view: ReviewerView, pr: string): ReviewerStatus[] {
  const rabbit = codeRabbit(view, pr);
  // unresolved threads beat every other state: they are what needs doing next
  const flag = (r: ReviewerStatus): ReviewerStatus => {
    const n = view.unresolved?.[r.name] ?? 0;
    return n > 0 ? { ...r, state: "comments", detail: String(n) } : r;
  };
  return [flag(copilot(view, pr)), ...(rabbit.state === "none" ? [] : [flag(rabbit)])];
}

export const REVIEWER_LOOK: Record<ReviewerState, { icon: string; color: "green" | "yellow" | "red" | "blue" | "grey" | "cyan" }> = {
  reviewing: { icon: "🟡", color: "yellow" },
  reviewed: { icon: "🟢", color: "green" },
  changes: { icon: "🔴", color: "red" },
  comments: { icon: "💬", color: "blue" },
  limited: { icon: "🚫", color: "yellow" },
  skipped: { icon: "⚪", color: "grey" },
  failed: { icon: "🔴", color: "red" },
  none: { icon: "⚪", color: "grey" },
};

/** The button text: `🟢 Copilot`, `🚫 CodeRabbit 56m`. */
export const reviewerLabel = (r: ReviewerStatus) => `${REVIEWER_LOOK[r.state].icon} ${r.name}${r.detail ? ` ${r.detail}` : ""}`;

/** The first comment's author on each review thread, and whether the thread is resolved: what the unresolved count reads. */
const THREADS_QUERY = "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login}}}}}}}}";

/** The `gh api graphql` command listing a PR's review threads, or undefined when `url` is not a GitHub PR URL. */
export function threadsCommand(url: string): string[] | undefined {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) return undefined;
  return ["gh", "api", "graphql", "-f", `query=${THREADS_QUERY}`, "-F", `owner=${m[1]}`, "-F", `repo=${m[2]}`, "-F", `number=${m[3]}`];
}

/** Unresolved review threads per reviewer, from `threadsCommand`'s output. A thread belongs to whoever opened it. */
export function parseUnresolved(out: string | undefined): NonNullable<ReviewerView["unresolved"]> {
  const counts: NonNullable<ReviewerView["unresolved"]> = {};
  try {
    const threads = JSON.parse(out ?? "")?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    for (const t of threads as { isResolved?: boolean; comments?: { nodes?: { author?: { login?: string } }[] } }[]) {
      if (t.isResolved) continue;
      const login = t.comments?.nodes?.[0]?.author?.login ?? "";
      const name = COPILOT.test(login) ? "Copilot" : CODERABBIT.test(login) ? "CodeRabbit" : undefined;
      if (name) counts[name] = (counts[name] ?? 0) + 1;
    }
  } catch {
    // no output or not JSON: no counts
  }
  return counts;
}
