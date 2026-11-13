/**
 * The server's cache: single flight per key, TTL, stale-while-revalidate, cached errors with backoff and a
 * global limit on fetches in flight. Pure: the clock is injected, so tests need no timers.
 */

export interface CacheOptions {
  /** Fetches running at once, across every key. */
  maxInFlight?: number;
  /** Wait after a key's first failure; doubles per further failure. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Entries kept; the oldest idle one goes first. */
  maxEntries?: number;
  now?: () => number;
  /** Told of every failed fetch, including those whose caller gets a stale value instead. */
  onError?: (key: string, error: Error) => void;
}

export interface GetOptions {
  /** A value fetched less than this long ago is served as it is. */
  ttlMs: number;
  /** An older value up to this age may be served while a refetch runs (with `swr`). */
  staleMs: number;
  /** Serve a value fetched after this call, whatever the TTL and any fetch already running. */
  force?: boolean;
  /** Return a stale value at once and refetch in the background instead of waiting. */
  swr?: boolean;
  /** The caller knows the cached value is out of date (its file is gone): refetch, but share a fetch already running. */
  expired?: boolean;
}

export type Served = "hit" | "stale" | "fresh" | "shared";

export interface Got<T> {
  value: T;
  served: Served;
  /** The last failure, when `value` is a stale one served after it. */
  error?: string;
}

interface Entry<T> {
  value?: T;
  /** When the fetch that produced `value` started. */
  atMs?: number;
  failures: number;
  retryAtMs: number;
  error?: string;
  /** The last failure, kept after a success clears `error`. */
  lastError?: string;
  lastErrorAtMs?: number;
  hits: number;
  misses: number;
  flight?: Promise<T>;
  /** The fetch a forced call queued behind the running one. */
  forced?: Promise<T>;
}

export interface CacheStats {
  hits: number;
  misses: number;
  shared: number;
  fetches: number;
  inFlight: number;
  queued: number;
  keys: Record<string, { atMs?: number; hits: number; misses: number; inFlight: boolean; failures: number; error?: string; lastError?: string; lastErrorAtMs?: number; retryAtMs?: number }>;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export class Cache<T> {
  private entries = new Map<string, Entry<T>>();
  private active = 0;
  private waiting: Array<() => void> = [];
  private counters = { hits: 0, misses: 0, shared: 0, fetches: 0 };
  private readonly maxInFlight: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly onError: (key: string, error: Error) => void;

  constructor(o: CacheOptions = {}) {
    this.maxInFlight = o.maxInFlight ?? 4;
    this.backoffBaseMs = o.backoffBaseMs ?? 15_000;
    this.backoffMaxMs = o.backoffMaxMs ?? 5 * 60_000;
    this.maxEntries = o.maxEntries ?? 2_000;
    this.now = o.now ?? Date.now;
    this.onError = o.onError ?? (() => undefined);
  }

  /** The value held for `key` whatever its age, without fetching or counting a hit; undefined when there is none. */
  peek(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  /** Whether any fetch is running or queued. */
  get busy(): boolean {
    return this.active > 0 || this.waiting.length > 0;
  }

  private entry(key: string): Entry<T> {
    let e = this.entries.get(key);
    if (e) return e;
    e = { failures: 0, retryAtMs: 0, hits: 0, misses: 0 };
    this.entries.set(key, e);
    if (this.entries.size > this.maxEntries) {
      for (const [k, v] of this.entries) {
        if (k !== key && !v.flight) {
          this.entries.delete(k);
          break;
        }
      }
    }
    return e;
  }

  private staleOrThrow(e: Entry<T>, err: unknown): Got<T> {
    if (e.value === undefined) throw asError(err);
    return { value: e.value, served: "stale", error: errorText(err) };
  }

  async get(key: string, fetch: () => Promise<T>, o: GetOptions): Promise<Got<T>> {
    const e = this.entry(key);
    const now = this.now();
    const cached = e.value;
    const age = e.atMs === undefined ? Infinity : now - e.atMs;
    const usable = cached !== undefined && age < o.staleMs;

    if (o.force) return this.forced(e, key, fetch);

    if (e.flight) {
      this.counters.shared++;
      if (o.swr && usable) return { value: cached, served: "stale" };
      try {
        return { value: await e.flight, served: "shared" };
      } catch (err) {
        return this.staleOrThrow(e, err);
      }
    }

    if (cached !== undefined && age < o.ttlMs && !o.expired) {
      this.counters.hits++;
      e.hits++;
      return { value: cached, served: "hit" };
    }
    if (now < e.retryAtMs) {
      this.counters.hits++;
      e.hits++;
      return this.staleOrThrow(e, new Error(e.error ?? "backing off"));
    }

    this.counters.misses++;
    e.misses++;
    const flight = this.start(key, e, fetch);
    if (o.swr && usable) {
      flight.catch(() => undefined);
      return { value: cached, served: "stale" };
    }
    try {
      return { value: await flight, served: "fresh" };
    } catch (err) {
      return this.staleOrThrow(e, err);
    }
  }

  /**
   * A fetch that starts after this call: the caller changed something (merged a PR) and must not be handed a fetch that
   * began before it. Waits for a running fetch, then runs one more that every forced caller meanwhile shares.
   */
  private async forced(e: Entry<T>, key: string, fetch: () => Promise<T>): Promise<Got<T>> {
    let next = e.forced;
    if (next) this.counters.shared++;
    else {
      const running = e.flight;
      this.counters.misses++;
      e.misses++;
      next = (running ? running.then(undefined, () => undefined) : Promise.resolve()).then(() => {
        e.forced = undefined;
        return this.start(key, e, fetch);
      });
      if (running) e.forced = next;
    }
    try {
      return { value: await next, served: "fresh" };
    } catch (err) {
      return this.staleOrThrow(e, err);
    }
  }

  stats(): CacheStats {
    const keys: CacheStats["keys"] = {};
    for (const [k, e] of this.entries) {
      keys[k] = {
        ...(e.atMs === undefined ? {} : { atMs: e.atMs }),
        hits: e.hits,
        misses: e.misses,
        inFlight: e.flight !== undefined,
        failures: e.failures,
        ...(e.error ? { error: e.error } : {}),
        ...(e.lastError ? { lastError: e.lastError, lastErrorAtMs: e.lastErrorAtMs } : {}),
        ...(e.retryAtMs > this.now() ? { retryAtMs: e.retryAtMs } : {}),
      };
    }
    return { ...this.counters, inFlight: this.active, queued: this.waiting.length, keys };
  }

  private start(key: string, e: Entry<T>, fetch: () => Promise<T>): Promise<T> {
    const startedAtMs = this.now();
    this.counters.fetches++;
    const flight = this.limited(fetch).then(
      (value) => {
        e.value = value;
        e.atMs = startedAtMs;
        e.failures = 0;
        e.retryAtMs = 0;
        e.error = undefined;
        e.flight = undefined;
        return value;
      },
      (err: unknown) => {
        e.failures++;
        e.error = errorText(err);
        e.lastError = e.error;
        e.lastErrorAtMs = this.now();
        e.retryAtMs = this.now() + Math.min(this.backoffBaseMs * 2 ** (e.failures - 1), this.backoffMaxMs);
        e.flight = undefined;
        this.onError(key, asError(err));
        throw err;
      },
    );
    e.flight = flight;
    return flight;
  }

  /** Run `fn` once a slot is free. A finishing run hands its slot straight to the next waiter. */
  private async limited<R>(fn: () => Promise<R>): Promise<R> {
    if (this.active >= this.maxInFlight) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
