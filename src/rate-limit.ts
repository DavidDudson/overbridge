import { errorText } from "./server-cache";

/**
 * GitHub rate-limit handling for the server. A `gh` failure that reads as a rate limit pauses every `gh` key until GitHub's
 * reset time: the keys serve what they hold (stale) and the pane message says so, instead of every refresh retrying into a
 * limit that only gets longer. Pure: the clock and the reset lookup are injected.
 */

/** What `gh` prints for a primary or secondary limit, and GraphQL's error type for one. */
const LIMITED = /api rate limit|secondary rate limit|rate limit exceeded|abuse detection|\bRATE_LIMITED\b/i;

export const isRateLimited = (text: string): boolean => LIMITED.test(text);

/** Pause used until the reset time is known (or when it cannot be read). */
export const DEFAULT_PAUSE_MS = 5 * 60_000;
/** A reset closer than this is stretched, and one further than the longest window (an hour) is cut back. */
export const MIN_PAUSE_MS = 30_000;
export const MAX_PAUSE_MS = 65 * 60_000;

export interface RateGateOptions {
  now?: () => number;
  /** When GitHub says the limit resets (ms since epoch), or undefined when it cannot be read. */
  lookupReset?: () => Promise<number | undefined>;
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
  private readonly lookupReset: () => Promise<number | undefined>;
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
    this.lookupReset().then(
      (reset) => {
        if (reset === undefined) return;
        this.untilMs = Math.min(Math.max(reset, now + MIN_PAUSE_MS), now + MAX_PAUSE_MS);
        this.log(`GitHub rate limit resets at ${clock(this.untilMs)}`);
      },
      (e: unknown) => this.log(`rate limit reset lookup failed: ${errorText(e)}`),
    );
    return true;
  }

  stats(): RateStats {
    const paused = this.message() !== undefined;
    return { paused, trips: this.trips, ...(paused ? { untilMs: this.untilMs, message: this.message()! } : {}) };
  }
}

/** The earliest reset among the `gh api rate_limit` resources that are used up (that endpoint is not itself limited). */
export async function ghResetLookup(): Promise<number | undefined> {
  const p = Bun.spawn(["gh", "api", "rate_limit", "--jq", "[.resources[] | select(.remaining == 0) | .reset] | min // empty"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
  const out = (await new Response(p.stdout).text()).trim();
  await p.exited;
  const seconds = Number(out);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
