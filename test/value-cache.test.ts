import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedValue } from "../src/value-cache";
import { refreshTitle } from "../src/pm/cache";
import { mergePr } from "../src/pr-actions";
import { fakeProvider } from "./helpers/fake-provider";
import type { RunResult } from "../src/util";

let tmp: string;
const saved = process.env.OVERBRIDGE_ROOT;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-vc-")));
  process.env.OVERBRIDGE_ROOT = tmp;
});
afterEach(() => {
  saved === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = saved);
  rmSync(tmp, { recursive: true, force: true });
});

describe("cachedValue", () => {
  test("fetches once per TTL, refetches after it, and serves the old value when the refetch fails", () => {
    let calls = 0;
    const fetch = (v: string | undefined) => () => (calls++, v);
    expect(cachedValue("k", 1000, fetch("a"), 0)).toBe("a");
    expect(cachedValue("k", 1000, fetch("b"), 999)).toBe("a");
    expect(calls).toBe(1);
    expect(cachedValue("k", 1000, fetch("b"), 1000)).toBe("b");
    expect(cachedValue("k", 1000, fetch(undefined), 5000)).toBe("b");
    expect(calls).toBe(3);
    expect(cachedValue("other", 1000, fetch(undefined), 0)).toBeUndefined();
  });
});

describe("refreshTitle with a TTL", () => {
  const items = [{ id: "7", title: "First", url: "u" }];
  test("an item named by many refreshes is fetched once per TTL", () => {
    const p = fakeProvider(items);
    for (const at of [0, 1, 2, 9]) expect(refreshTitle(p, "o/r", "7", { ttlMs: 10, now: at })).toBe("First");
    expect(p.calls).toBe(1);
    refreshTitle(p, "o/r", "7", { ttlMs: 10, now: 10 });
    expect(p.calls).toBe(2);
  });

  test("without a TTL it always fetches", () => {
    const p = fakeProvider(items);
    refreshTitle(p, "o/r", "7");
    refreshTitle(p, "o/r", "7");
    expect(p.calls).toBe(2);
  });
});

describe("mergePr settings", () => {
  const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
  test("reads the repo's merge settings once for every merge in the TTL, and falls back to a direct read with no slug", () => {
    const calls: string[] = [];
    const exec = (cmd: string[]) => (calls.push(cmd.slice(0, 3).join(" ")), cmd[1] === "repo" ? ok('{"squashMergeAllowed":true}') : ok(""));
    mergePr({ dir: "/a", number: 1, stack: [] }, exec, () => "o/r");
    mergePr({ dir: "/b", number: 2, stack: [] }, exec, () => "o/r");
    expect(calls.filter((c) => c === "gh repo view")).toHaveLength(1);
    mergePr({ dir: "/c", number: 3, stack: [] }, exec, () => undefined);
    mergePr({ dir: "/c", number: 3, stack: [] }, exec, () => undefined);
    expect(calls.filter((c) => c === "gh repo view")).toHaveLength(3);
  });
});
