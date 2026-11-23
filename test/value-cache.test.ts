import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedValue, ghAccountStamp } from "../src/value-cache";
import { refreshLineage, refreshTitle } from "../src/pm/cache";
import { cachedTicket, PARENT_TTL_MS, type RawIssue } from "../src/pm/board-jira";
import { mkdirSync, writeFileSync } from "node:fs";
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

describe("refreshLineage with a TTL", () => {
  const items = [{ id: "1", title: "Epic", url: "u" }, { id: "7", title: "Task", url: "u" }];
  const parents = { "7": "1" };

  test("fetches once per TTL and refetches at it", () => {
    let calls = 0;
    const p = fakeProvider(items, "github", [], parents);
    const counted = { ...p, lineage: (id: string) => (calls++, p.lineage(id)) };

    for (const at of [0, 5, 9]) expect(refreshLineage(counted, "o/r", "7", { ttlMs: 10, now: at }).map((n) => n.id)).toEqual(["1", "7"]);
    expect(calls).toBe(1);
    refreshLineage(counted, "o/r", "7", { ttlMs: 10, now: 10 });
    expect(calls).toBe(2);
  });

  test("an empty fetch keeps the stored lineage", () => {
    refreshLineage(fakeProvider(items, "github", [], parents), "o/r", "7", { now: 0 });
    const offline = { ...fakeProvider(items), lineage: () => [] };
    expect(refreshLineage(offline, "o/r", "7", { ttlMs: 10, now: 100 }).map((n) => n.id)).toEqual(["1", "7"]);
    expect(refreshLineage(offline, "o/r", "8", { now: 100 })).toEqual([]);
  });

  test("a misshapen store entry is refetched, never returned", () => {
    mkdirSync(join(tmp, ".overbridge"), { recursive: true });
    writeFileSync(join(tmp, ".overbridge", "lineage.json"), JSON.stringify({ "github:o/r:7": { at: 0, nodes: [{ id: "7", title: "x", status: "" }] } }));
    let calls = 0;
    const p = fakeProvider(items, "github", [], parents);
    const counted = { ...p, lineage: (id: string) => (calls++, p.lineage(id)) };
    expect(refreshLineage(counted, "o/r", "7", { ttlMs: 1000, now: 1 }).map((n) => n.url)).toEqual(["https://fake.test/items/1", "https://fake.test/items/7"]);
    expect(calls).toBe(1);
  });
});

describe("cachedTicket", () => {
  const ticket = (key: string): RawIssue => ({ key, fields: { summary: `s${key}`, issuetype: { name: "Epic" }, parent: null } });

  test("reads each key once per TTL, keeps keys apart, and serves the last good read when a read fails", () => {
    const reads: string[] = [];
    let up = true;
    const now = Date.now();
    const realNow = Date.now;
    const read = cachedTicket((key) => (reads.push(key), up ? ticket(key) : undefined));

    try {
      expect(read("A-1")).toEqual(ticket("A-1"));
      expect(read("A-1")).toEqual(ticket("A-1"));
      expect(read("A-2")).toEqual(ticket("A-2"));
      expect(reads).toEqual(["A-1", "A-2"]);
      up = false;
      Date.now = () => now + PARENT_TTL_MS;
      expect(read("A-1")).toEqual(ticket("A-1"));
      expect(read("A-9")).toBeUndefined();
      expect(reads).toEqual(["A-1", "A-2", "A-1", "A-9"]);
    } finally {
      Date.now = realNow;
    }
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

  test("a merge that fails on cached settings re-reads them and retries once with the method the repo now allows", () => {
    let allowed = '{"squashMergeAllowed":true}';
    const merges: string[] = [];

    const exec = (cmd: string[]): RunResult => {
      if (cmd[1] === "repo") return ok(allowed);
      merges.push(cmd[4]!);

      return cmd[4] === "--squash" && allowed.includes("mergeCommit") ? { ok: false, code: 1, stdout: "", stderr: "squash disabled" } : ok("");
    };

    mergePr({ dir: "/a", number: 1, stack: [] }, exec, () => "o/x"); // caches squash
    allowed = '{"mergeCommitAllowed":true}';
    expect(mergePr({ dir: "/a", number: 2, stack: [] }, exec, () => "o/x")).toBe("merged PR #2");
    expect(merges).toEqual(["--squash", "--squash", "--merge"]);
  });

  test("a merge refused for another reason does not re-read the settings", () => {
    const calls: string[] = [];

    const exec = (cmd: string[]): RunResult => {
      calls.push(cmd[1]!);

      return cmd[1] === "repo" ? ok('{"squashMergeAllowed":true}') : { ok: false, code: 1, stdout: "", stderr: "Pull request is not mergeable: required checks have not passed" };
    };

    expect(mergePr({ dir: "/a", number: 1, stack: [] }, exec, () => "o/y")).toContain("not mergeable");
    expect(calls.filter((c) => c === "repo")).toHaveLength(1);
  });
});

describe("ghAccountStamp", () => {
  test("follows the token in the environment, and hosts.yml's mtime otherwise", () => {
    const keep = { t: process.env.GH_TOKEN, g: process.env.GITHUB_TOKEN, d: process.env.GH_CONFIG_DIR };

    try {
      delete process.env.GITHUB_TOKEN;
      process.env.GH_TOKEN = "a";
      const a = ghAccountStamp();
      process.env.GH_TOKEN = "b";
      expect(ghAccountStamp()).not.toBe(a);
      delete process.env.GH_TOKEN;
      process.env.GH_CONFIG_DIR = tmp;
      expect(ghAccountStamp()).toBe("none");
      require("node:fs").writeFileSync(join(tmp, "hosts.yml"), "x");
      expect(ghAccountStamp()).toMatch(/^\d+$/);
    } finally {
      for (const [k, v] of [["GH_TOKEN", keep.t], ["GITHUB_TOKEN", keep.g], ["GH_CONFIG_DIR", keep.d]] as const) v === undefined ? delete process.env[k] : (process.env[k] = v);
    }
  });
});
