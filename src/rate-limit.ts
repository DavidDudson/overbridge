import { errorText } from "./server-cache";

/**
 * GitHub rate-limit handling for the server. A `gh` failure that reads as a rate limit pauses every `gh` key until GitHub's
 * reset time: the keys serve what they hold (stale) and the pane message says so, instead of every refresh retrying into a
 * limit that only gets longer. Pure: the clock and the reset lookup are injected.
 */

/** What `gh` prints for a primary or secondary limit, and GraphQL's error type for one. */
const LIMITED = /api rate limit|secondary rate limit|rate limit exceeded|abuse detection|\bRATE_LIMITED\b/i;

export const isRateLimited = (text: string): boolean => LIMITED.test(text);

/** The GitHub API whose budget a limit used up. Each keeps its own count and reset time. */
export const GitHubApi = { Rest: "rest", GraphQL: "graphql" } as const;

export type GitHubApi = (typeof GitHubApi)[keyof typeof GitHubApi];

/** `gh` prefixes a GraphQL error with `GraphQL:`, and a GraphQL reply names its limit `RATE_LIMITED`. */
const GRAPHQL = /\bGraphQL\b|\bRATE_LIMITED\b/;

/** Which API a rate-limit failure came from. */
export const limitedApi = (text: string): GitHubApi => (GRAPHQL.test(text) ? GitHubApi.GraphQL : GitHubApi.Rest);

/** Pause used until the reset time is known (or when it cannot be read). */
export const DEFAULT_PAUSE_MS = 5 * 60_000;

/** A reset closer than this is stretched, and one further than the longest window (an hour) is cut back. */
export const MIN_PAUSE_MS = 30_000;
export const MAX_PAUSE_MS = 65 * 60_000;

export interface RateGateOptions {
  now?: () => number;
  /** When GitHub says `api`'s limit resets (ms since epoch), or undefined when it cannot be read. */
  lookupReset?: (api: GitHubApi) => Promise<number | undefined>;
  log?: (msg: string) => void;
}

export interface RateStats {
  paused: boolean;
  /** When the pause ends (ms since epoch). */
  untilMs?: number;
  /** Times the limit was hit since the server started. */
  trips: number;
  message?: string;
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-GB");

export class RateGate {
  private untilMs = 0;
  private trips = 0;
  /** The pause (its trip number) a forced refresh has already been let through. */
  private forcedIn = 0;
  private readonly now: () => number;
  private readonly lookupReset: (api: GitHubApi) => Promise<number | undefined>;
  private readonly log: (msg: string) => void;

  constructor(o: RateGateOptions = {}) {
    this.now = o.now ?? Date.now;
    this.lookupReset = o.lookupReset ?? (async () => undefined);
    this.log = o.log ?? (() => undefined);
  }

  /** Why `gh` is paused, worded for the pane's message row; undefined when it is not. */
  message(): string | undefined {
    const now = this.now();

    return now < this.untilMs ? `GitHub rate limit reached: gh calls paused until ${clock(this.untilMs)}, showing cached data` : undefined;
  }

  /**
   * Whether a forced refresh (the user's `r`) may call `gh` now. Always, outside a pause. Inside one, the first only: it
   * tells whether the limit is really still on, and if it is the failure moves nothing, so holding `r` cannot keep calling
   * into the limit.
   */
  allowForced(): boolean {
    if (this.message() === undefined) return true;

    if (this.forcedIn === this.trips) return false;
    this.forcedIn = this.trips;

    return true;
  }

  /**
   * Look at a failure's text. A rate-limit reply pauses `gh` (not shortened if already paused longer) and returns true; the
   * pause is the default at first and is moved to the real reset as soon as that is read.
   */
  observe(text: string): boolean {
    if (!isRateLimited(text)) return false;
    const now = this.now();

    // a failure from a call that started before the pause says nothing new
    if (now < this.untilMs) return true;
    this.trips++;
    this.untilMs = now + DEFAULT_PAUSE_MS;
    this.log(`GitHub rate limit hit: pausing gh until ${clock(this.untilMs)}`);
    void this.learnReset(now, limitedApi(text));

    return true;
  }

  /** Move the pause to the real reset once `gh` says when it is; a failed lookup keeps the default pause. */
  private async learnReset(now: number, api: GitHubApi): Promise<void> {
    try {
      const reset = await this.lookupReset(api);

      if (reset === undefined) return;
      this.untilMs = Math.min(Math.max(reset, now + MIN_PAUSE_MS), now + MAX_PAUSE_MS);
      this.log(`GitHub rate limit resets at ${clock(this.untilMs)}`);
    } catch (e) {
      this.log(`rate limit reset lookup failed: ${errorText(e)}`);
    }
  }

  stats(): RateStats {
    const message = this.message();
    const stats: RateStats = { paused: message !== undefined, trips: this.trips };

    if (message !== undefined) {
      stats.untilMs = this.untilMs;
      stats.message = message;
    }

    return stats;
  }
}

/** Runs `gh` with these arguments and resolves its trimmed stdout. */
export type GhOutput = (args: string[]) => Promise<string>;

const ghOutput: GhOutput = async (args) => {
  const p = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;

  return out;
};

const RATE_LIMIT_QUERY = "query{rateLimit{resetAt}}";

/**
 * When `api`'s limit resets. GraphQL's reset comes from its own `rateLimit` field, because `gh api rate_limit` can report
 * GraphQL points left while GraphQL refuses every call. REST's is the earliest reset among the used-up `gh api rate_limit`
 * resources. Neither read is itself limited.
 */
export async function ghResetLookup(api: GitHubApi, gh: GhOutput = ghOutput): Promise<number | undefined> {
  if (api === GitHubApi.GraphQL) {
    const ms = Date.parse(await gh(["api", "graphql", "-f", `query=${RATE_LIMIT_QUERY}`, "--jq", ".data.rateLimit.resetAt"]));

    return Number.isFinite(ms) ? ms : undefined;
  }

  const seconds = Number(await gh(["api", "rate_limit", "--jq", "[.resources[] | select(.remaining == 0) | .reset] | min // empty"]));

  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
