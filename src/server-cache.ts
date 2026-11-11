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
}

export interface GetOptions {
  /** A value fetched less than this long ago is served as it is. */
  ttlMs: number;
  /** An older value up to this age may be served while a refetch runs (with `swr`). */
  staleMs: number;
  /** Skip the TTL, but not more often than `minForceGapMs`. */
  force?: boolean;
  minForceGapMs?: number;
  /** Return a stale value at once and refetch in the background instead of waiting. */
  swr?: boolean;
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
  at?: number;
  lastStart: number;
  failures: number;
  retryAt: number;
  error?: string;
  flight?: Promise<T>;
}

export interface CacheStats {
  hits: number;
  misses: number;
  shared: number;
  fetches: number;
  inFlight: number;
  queued: number;
  keys: Record<string, { at?: number; failures: number; error?: string; retryAt?: number }>;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Cache<T> {
  private entries = new Map<string, Entry<T>>();
  private active = 0;
  private waiting: Array<() => void> = [];
  private counters = { hits: 0, misses: 0, shared: 0, fetches: 0 };
  private readonly max: number;
  private readonly base: number;
  private readonly cap: number;
  private readonly size: number;
  private readonly now: () => number;

  constructor(o: CacheOptions = {}) {
    this.max = o.maxInFlight ?? 4;
    this.base = o.backoffBaseMs ?? 15_000;
    this.cap = o.backoffMaxMs ?? 5 * 60_000;
    this.size = o.maxEntries ?? 2_000;
    this.now = o.now ?? Date.now;
  }

  /** Whether any fetch is running or queued. */
  get busy(): boolean {
    return this.active > 0 || this.waiting.length > 0;
  }

  private entry(key: string): Entry<T> {
    let e = this.entries.get(key);
    if (e) return e;
    e = { lastStart: -Infinity, failures: 0, retryAt: 0 };
    this.entries.set(key, e);
    if (this.entries.size > this.size) {
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
    if (e.value === undefined) throw err instanceof Error ? err : new Error(errorText(err));
    return { value: e.value, served: "stale", error: errorText(err) };
  }

  async get(key: string, fetch: () => Promise<T>, o: GetOptions): Promise<Got<T>> {
    const e = this.entry(key);
    const now = this.now();
    const age = e.at === undefined ? Infinity : now - e.at;
    const usable = e.value !== undefined && age < o.staleMs;

    if (e.flight) {
      this.counters.shared++;
      if (o.swr && usable) return { value: e.value as T, served: "stale" };
      try {
        return { value: await e.flight, served: "shared" };
      } catch (err) {
        return this.staleOrThrow(e, err);
      }
    }

    const force = o.force === true && now - e.lastStart >= (o.minForceGapMs ?? 5_000);
    if (e.value !== undefined && age < o.ttlMs && !force) {
      this.counters.hits++;
      return { value: e.value, served: "hit" };
    }
    if (now < e.retryAt && !force) {
      this.counters.hits++;
      return this.staleOrThrow(e, new Error(e.error ?? "backing off"));
    }

    this.counters.misses++;
    const flight = this.start(e, fetch);
    if (o.swr && usable) {
      flight.catch(() => undefined);
      return { value: e.value as T, served: "stale" };
    }
    try {
      return { value: await flight, served: "fresh" };
    } catch (err) {
      return this.staleOrThrow(e, err);
    }
  }

  /** Forget a key, or every key starting with `prefix`. */
  invalidate(keyOrPrefix: string, prefix = false) {
    for (const k of [...this.entries.keys()]) {
      if (k === keyOrPrefix || (prefix && k.startsWith(keyOrPrefix))) {
        const e = this.entries.get(k)!;
        // a running fetch keeps its entry; only the value is dropped
        if (e.flight) e.at = undefined;
        else this.entries.delete(k);
      }
    }
  }

  stats(): CacheStats {
    const keys: CacheStats["keys"] = {};
    for (const [k, e] of this.entries) {
      keys[k] = { ...(e.at === undefined ? {} : { at: e.at }), failures: e.failures, ...(e.error ? { error: e.error } : {}), ...(e.retryAt > this.now() ? { retryAt: e.retryAt } : {}) };
    }
    return { ...this.counters, inFlight: this.active, queued: this.waiting.length, keys };
  }

  private start(e: Entry<T>, fetch: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    e.lastStart = startedAt;
    this.counters.fetches++;
    const flight = this.limited(fetch).then(
      (value) => {
        e.value = value;
        e.at = startedAt;
        e.failures = 0;
        e.retryAt = 0;
        e.error = undefined;
        e.flight = undefined;
        return value;
      },
      (err: unknown) => {
        e.failures++;
        e.error = errorText(err);
        e.retryAt = this.now() + Math.min(this.base * 2 ** (e.failures - 1), this.cap);
        e.flight = undefined;
        throw err;
      },
    );
    e.flight = flight;
    return flight;
  }

  /** Run `fn` once a slot is free. A finishing run hands its slot straight to the next waiter. */
  private async limited<R>(fn: () => Promise<R>): Promise<R> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.waiting.push(resolve));
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
