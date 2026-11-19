import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carrySeenAt, isSilenced, parseMentions, parseStore, readMentions, readStore, type SilenceStore, silencedSince, toggled, watchedUrls } from "../src/silence";
import { isGithubItem, mentionCommand, mentionQuery, mentionsUser, newestMention, parseMentionReply, scanMentions, URLS_PER_QUERY } from "../src/mention-scan";
import { keepNewest, listedRows, listedUrls, MENTION_MAX_AGE_MS, MENTION_REFRESH_MS, mentionScanError, mentionSignature, refreshMentions, spawnMentionRefresh, toggleMessage, toggleSilence } from "../src/silence-refresh";
import { prBadgeFromCache, prListBadge, workBadgeFromCache } from "../src/my-badges";
import { readPrList, refreshPrList, renderPrList } from "../src/prlist-run";
import { renderWorklist } from "../src/worklist-run";
import { rank, type WorkRow } from "../src/pm/worklist";
import { prsView } from "../src/prs-view";
import { reviewsView } from "../src/reviews-view";
import type { PrRow } from "../src/pr-rows";
import type { RunResult } from "../src/util";

const URL_A = "https://github.com/o/r/pull/1";
const URL_B = "https://github.com/o/r/issues/2";
const T0 = "2026-11-10T00:00:00Z";
const T1 = "2026-11-11T00:00:00Z";
const T2 = "2026-11-12T00:00:00Z";

const store = (entries: [string, "silenced" | "unsilenced", string][]): SilenceStore => new Map(entries.map(([url, state, at]) => [url, { state, at }]));

const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });

const pr = (over: Partial<PrRow> = {}): PrRow => ({ repo: "o/r", number: 1, title: "Fix", url: URL_A, author: "bob", draft: false, updatedAt: T1, ...over });

const work = (over: Partial<WorkRow> = {}): WorkRow => ({ repo: "r", id: "2", title: "Issue", url: URL_B, status: "todo", labels: [], blockedBy: [], updatedAt: T1, ...over });

/** A list cache as the badge reads it from disk. */
const cacheOf = (rows: readonly (PrRow | WorkRow)[]) => JSON.parse(JSON.stringify({ rows }));

const strip = (lines: string[]) => lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

describe("isSilenced", () => {
  test("an item with no entry is loud; a direct review too", () => {
    expect(isSilenced({ url: URL_A }, new Map(), new Map())).toBe(false);
    expect(isSilenced({ url: URL_A, group: "direct", seenAt: T0 }, new Map(), new Map())).toBe(false);
  });

  test("a silenced entry stays silenced until a later mention", () => {
    const s = store([[URL_A, "silenced", T1]]);
    expect(isSilenced({ url: URL_A }, s, new Map())).toBe(true);
    expect(isSilenced({ url: URL_A }, s, new Map([[URL_A, T0]]))).toBe(true);
    expect(isSilenced({ url: URL_A }, s, new Map([[URL_A, T2]]))).toBe(false);
  });

  test("a team review starts silenced from its first sighting", () => {
    const team = { url: URL_A, group: "team" as const, seenAt: T1 };
    expect(silencedSince(team, new Map())).toBe(Date.parse(T1));
    expect(isSilenced(team, new Map(), new Map())).toBe(true);
    expect(isSilenced(team, new Map(), new Map([[URL_A, T0]]))).toBe(true);
    expect(isSilenced(team, new Map(), new Map([[URL_A, T2]]))).toBe(false);
  });

  test("a team review with no seenAt lifts on any mention", () => {
    expect(isSilenced({ url: URL_A, group: "team" }, new Map(), new Map([[URL_A, T0]]))).toBe(false);
  });

  test("the user's unsilence beats the team default", () => {
    expect(isSilenced({ url: URL_A, group: "team", seenAt: T0 }, store([[URL_A, "unsilenced", T1]]), new Map())).toBe(false);
  });

  test("a mention at exactly the silence time keeps it", () => {
    expect(isSilenced({ url: URL_A }, store([[URL_A, "silenced", T1]]), new Map([[URL_A, T1]]))).toBe(true);
  });

  test("an unreadable mention time keeps the silence", () => {
    expect(isSilenced({ url: URL_A }, store([[URL_A, "silenced", T1]]), new Map([[URL_A, "garbage"]]))).toBe(true);
  });
});

describe("toggled", () => {
  test("flips the item and drops entries no tab lists", () => {
    const before = store([[URL_B, "silenced", T0], ["https://github.com/o/r/pull/9", "silenced", T0]]);
    const after = toggled(before, { url: URL_A }, new Map(), T1, new Set([URL_A, URL_B]));
    expect([...after.keys()].sort()).toEqual([URL_A, URL_B].sort());
    expect(after.get(URL_A)).toEqual({ state: "silenced", at: T1 });
    expect(toggled(after, { url: URL_A }, new Map(), T2, new Set([URL_A])).get(URL_A)).toEqual({ state: "unsilenced", at: T2 });
  });

  test("keeps every entry when the lists are not all read yet", () => {
    expect(toggled(store([[URL_B, "silenced", T0]]), { url: URL_A }, new Map(), T1, undefined).get(URL_B)).toEqual({ state: "silenced", at: T0 });
  });

  test("toggling a team review unsilences it", () => {
    expect(toggled(new Map(), { url: URL_A, group: "team", seenAt: T0 }, new Map(), T1, new Set([URL_A])).get(URL_A)?.state).toBe("unsilenced");
  });

  test("re-silencing after a mention silences again from now", () => {
    const s = toggled(store([[URL_A, "silenced", T0]]), { url: URL_A }, new Map([[URL_A, T1]]), T2, new Set([URL_A]));
    expect(s.get(URL_A)).toEqual({ state: "silenced", at: T2 });
    expect(isSilenced({ url: URL_A }, s, new Map([[URL_A, T1]]))).toBe(true);
  });
});

describe("store parsing", () => {
  test("bad entries are skipped", () => {
    const s = parseStore({ items: { [URL_A]: { state: "silenced", at: T1 }, [URL_B]: { state: "loud", at: T1 }, x: 3 } });
    expect([...s.keys()]).toEqual([URL_A]);
    expect(parseStore(null).size).toBe(0);
  });

  test("mentions parse with their error", () => {
    const m = parseMentions({ at: 5, mentions: { [URL_A]: T1, [URL_B]: 7 }, error: "boom" });
    expect(m).toEqual({ at: 5, mentions: new Map([[URL_A, T1]]), error: "boom" });
    expect(parseMentions("nope")).toEqual({ at: 0, mentions: new Map() });
  });
});

describe("watchedUrls and carrySeenAt", () => {
  test("watches silenced entries and team reviews on GitHub only", () => {
    const s = store([[URL_B, "silenced", T0], ["https://jira.example/browse/ENG-1", "silenced", T0], ["https://github.com/o/r/pull/5", "unsilenced", T0]]);
    expect(watchedUrls([{ url: URL_A, group: "team" }, { url: "https://github.com/o/r/pull/6", group: "direct" }], s)).toEqual([URL_B, URL_A]);
    expect(watchedUrls([{ url: "https://github.com/o/r/pull/5", group: "team" }], s)).toEqual([URL_B]);
  });

  test("keeps the first sighting of a row already listed", () => {
    const rows = carrySeenAt([pr(), pr({ url: URL_B })], [pr({ seenAt: T0 })], T2);
    expect(rows.map((r) => r.seenAt)).toEqual([T0, T2]);
  });
});

describe("mention scan", () => {
  test("matches a handle, not an email, a path or a longer handle", () => {
    expect(mentionsUser("cc @DavidDudson please", "daviddudson")).toBe(true);
    expect(mentionsUser("@DavidDudson: look", "DavidDudson")).toBe(true);
    expect(mentionsUser("mail a@DavidDudson.com", "DavidDudson")).toBe(false);
    expect(mentionsUser("see @DavidDudson-bot", "DavidDudson")).toBe(false);
    expect(mentionsUser("org/@DavidDudson", "DavidDudson")).toBe(false);
  });

  test("passes URLs as variables, never in the query text", () => {
    const cmd = mentionCommand([URL_A, URL_B]);
    expect(mentionQuery(2)).toContain("$u1:URI!");
    expect(cmd.join(" ")).not.toContain(`url:"${URL_A}"`);
    expect(cmd).toContain(`u1=${URL_B}`);
  });

  test("newest mention by someone else wins; the user's own comments do not count", () => {
    const texts = [
      { author: "amy", body: "@me hi", createdAt: T0 },
      { author: "me", body: "@me note to self", createdAt: T2 },
      { author: "bob", body: "@me ping", createdAt: T1 },
      { author: "cat", body: "no mention", createdAt: T2 },
    ];

    expect(newestMention(texts, "me")).toBe(T1);
    expect(newestMention([], "me")).toBeUndefined();
  });

  test("reads issue comments, review bodies and review comments", () => {
    const reply = {
      data: {
        m0: { comments: { nodes: [] }, reviews: { nodes: [{ author: { login: "bob" }, body: "", createdAt: T0, comments: { nodes: [{ author: { login: "bob" }, body: "@me here", createdAt: T2 }] } }] } },
        m1: { comments: { nodes: [{ author: { login: "amy" }, body: "@me", createdAt: T1 }] } },
        m2: null,
      },
    };

    expect(parseMentionReply(JSON.stringify(reply), [URL_A, URL_B, "https://github.com/o/r/issues/3"], "me")).toEqual(new Map([[URL_A, T2], [URL_B, T1]]));
  });

  test("a reply with no data fails with GitHub's message", () => {
    expect(() => parseMentionReply(JSON.stringify({ errors: [{ message: "bad credentials" }] }), [URL_A], "me")).toThrow("bad credentials");
    expect(() => parseMentionReply("<html>", [URL_A], "me")).toThrow("not JSON");
  });

  test("a published review is dated by when it was published, not when its draft started", () => {
    const reply = { data: { m0: { comments: { nodes: [] }, reviews: { nodes: [{ author: { login: "bob" }, body: "@me look", createdAt: T0, publishedAt: T2, comments: { nodes: [] } }] } } } };

    expect(parseMentionReply(JSON.stringify(reply), [URL_A], "me").get(URL_A)).toBe(T2);
  });

  test("keeps a mention that scrolled out of the scan window, and drops URLs no longer watched", () => {
    expect(keepNewest(new Map([[URL_A, T1], ["https://github.com/o/r/pull/9", T1]]), new Map([[URL_B, T2]]), [URL_A, URL_B])).toEqual(new Map([[URL_A, T1], [URL_B, T2]]));
    expect(keepNewest(new Map([[URL_A, T2]]), new Map([[URL_A, T1]]), [URL_A]).get(URL_A)).toBe(T2);
  });

  test("a page where one item errored still reads the others", () => {
    const partial = JSON.stringify({ data: { m0: { comments: { nodes: [{ author: { login: "x" }, body: "@me", createdAt: T1 }] } }, m1: null }, errors: [{ message: "Could not resolve to a node" }] });
    expect(scanMentions([URL_A, URL_B], "me", () => ({ ok: false, code: 1, stdout: partial, stderr: "Could not resolve to a node" })).get(URL_A)).toBe(T1);
    expect(isGithubItem(URL_A)).toBe(true);
    expect(isGithubItem("https://jira.example/browse/ENG-1")).toBe(false);
  });

  test("pages the URLs and reports gh's error", () => {
    const urls = Array.from({ length: URLS_PER_QUERY + 1 }, (_, i) => `https://github.com/o/r/issues/${i}`);
    const calls: string[][] = [];

    const found = scanMentions(urls, "me", (cmd) => {
      calls.push(cmd);

      return ok(JSON.stringify({ data: { m0: { comments: { nodes: [{ author: { login: "x" }, body: "@me", createdAt: T1 }] } } } }));
    });

    expect(calls).toHaveLength(2);
    expect(found.get(urls[0]!)).toBe(T1);
    expect(found.get(urls[URLS_PER_QUERY]!)).toBe(T1);
    expect(() => scanMentions([URL_A], "me", () => ({ ok: false, code: 1, stdout: "", stderr: "HTTP 502\nmore" }))).toThrow("gh api graphql failed: HTTP 502");
  });
});

describe("badges leave out silenced rows", () => {
  test("PR list badge", () => {
    const silenced = (r: { url: string }) => r.url === URL_A;
    expect(prBadgeFromCache(cacheOf([pr(), pr({ url: URL_B, number: 2 })]), silenced)?.count).toBe(1);
    expect(prBadgeFromCache(cacheOf([pr()]))?.count).toBe(1);
  });

  test("a team review leaves the badge by the real rule", () => {
    const rows = cacheOf([pr({ group: "team", seenAt: T0 }), pr({ url: URL_B, number: 2, group: "direct", seenAt: T0 })]);
    expect(prBadgeFromCache(rows, (r) => isSilenced(r, new Map(), new Map()))?.count).toBe(1);
  });

  test("work badge", () => {
    expect(workBadgeFromCache(cacheOf([work(), work({ id: "3", url: "https://github.com/o/r/issues/3" })]), (r) => r.url === URL_B)?.count).toBe(1);
  });
});

describe("views draw a silenced row dim with a bell", () => {
  const view = { selected: 9, offset: 0, height: 12, width: 120, message: "", now: Date.parse(T2) };

  test("my PRs and reviews", () => {
    expect(strip(prsView.render([pr()], { ...view, silenced: new Set([URL_A]) }))).toContain("🔕 Fix");
    expect(strip(prsView.render([pr()], view))).not.toContain("🔕");
    expect(strip(reviewsView.render([pr({ group: "team" })], { ...view, silenced: new Set([URL_A]) }))).toContain("🔕 Fix");
    expect(strip(renderPrList("reviews", [], 0, 0, 12, 120))).toContain("x silence");
  });

  test("work", () => {
    const out = strip(renderWorklist(rank([work()]), 9, 0, 12, 120, "", [], "", Date.parse(T2), new Set([URL_B])));
    expect(out).toContain("🔕 Issue");
    expect(out).toContain("x silence");
  });
});

describe("on disk", () => {
  let tmp: string;
  const savedRoot = process.env.OVERBRIDGE_ROOT;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "overbridge-silence-"));
    process.env.OVERBRIDGE_ROOT = tmp;
    mkdirSync(join(tmp, ".overbridge"), { recursive: true });
    writeFileSync(join(tmp, ".overbridge", "prlist-reviews.json"), JSON.stringify({ at: 1, rows: [pr({ group: "team", seenAt: T0 })] }));
    writeFileSync(join(tmp, ".overbridge", "worklist.json"), JSON.stringify({ at: 1, rows: [work()], notes: [] }));
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.OVERBRIDGE_ROOT;
    else process.env.OVERBRIDGE_ROOT = savedRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("toggle writes the store; a scan finds the mention that lifts it", () => {
    expect(listedRows().map((r) => r.url)).toEqual([URL_A, URL_B]);
    expect(toggleSilence({ url: URL_B }, new Date(T1))).toBe("silenced");
    expect(readStore().get(URL_B)).toEqual({ state: "silenced", at: new Date(T1).toISOString() });

    const runner = (cmd: string[]): RunResult =>
      cmd.includes("user") ? ok("me\n") : ok(JSON.stringify({ data: { m0: { comments: { nodes: [{ author: { login: "amy" }, body: "@me", createdAt: T2 }] } }, m1: null } }));

    const cache = refreshMentions(5, runner);
    expect(cache.mentions.get(URL_B)).toBe(T2);
    expect(isSilenced({ url: URL_B }, readStore(), readMentions().mentions)).toBe(false);
    expect(isSilenced({ url: URL_A, group: "team", seenAt: T0 }, readStore(), readMentions().mentions)).toBe(true);
  });

  test("the reviews badge leaves out the team review on disk", () => {
    expect(prListBadge("reviews")?.count).toBe(0);
  });

  test("a toggle keeps another list's silences while that list has never been read", () => {
    writeFileSync(join(tmp, ".overbridge", "silenced.json"), JSON.stringify({ items: { "https://github.com/o/r/pull/9": { state: "silenced", at: T0 } } }));
    expect(listedUrls()).toBeUndefined();
    toggleSilence({ url: URL_B }, new Date(T1));
    expect(readStore().has("https://github.com/o/r/pull/9")).toBe(true);
  });

  test.each(["{ half", "[]", '{"item":{}}'])("a toggle refuses to overwrite a store it cannot read: %s", (body) => {
    writeFileSync(join(tmp, ".overbridge", "silenced.json"), body);
    expect(toggleMessage({ url: URL_B }, "o/r#2")).toStartWith("error: could not save the silence for o/r#2:");
    expect(readFileSync(join(tmp, ".overbridge", "silenced.json"), "utf8")).toBe(body);
  });

  test("a refresh keeps each row's first sighting", () => {
    const node = { number: 1, title: "Fix", url: URL_A, isDraft: false, updatedAt: T2, repository: { nameWithOwner: "o/r" }, reviewRequests: { nodes: [] } };

    const runner = (cmd: string[]): RunResult => (cmd.includes("user") ? ok("me\n") : ok(JSON.stringify({ data: { search: { nodes: [node] } } })));

    refreshPrList("reviews", Date.parse(T2), runner);
    expect(readPrList("reviews").rows.map((r) => r.seenAt)).toEqual([T0]);
  });

  test("panes that refresh together start one scan; a stale or unreadable claim starts another", () => {
    const spawned: string[][] = [];
    const spawn = (cmd: string[]) => void spawned.push(cmd);
    const t = Date.parse(T2);

    expect(spawnMentionRefresh(t, spawn)).toBe("");
    spawnMentionRefresh(t + 1000, spawn);
    expect(spawned).toHaveLength(1);
    spawnMentionRefresh(t + MENTION_REFRESH_MS, spawn);
    expect(spawned).toHaveLength(2);
    writeFileSync(join(tmp, ".overbridge", "mentions.claim"), "junk");
    spawnMentionRefresh(t + MENTION_REFRESH_MS + 1, spawn);
    expect(spawned).toHaveLength(3);
    expect(spawned[0]!.slice(-2)).toEqual(["silence", "refresh"]);
  });

  test("once every list is read, a toggle drops silences no tab lists and keeps the toggled item", () => {
    writeFileSync(join(tmp, ".overbridge", "prlist-prs.json"), JSON.stringify({ at: 1, rows: [] }));
    writeFileSync(join(tmp, ".overbridge", "silenced.json"), JSON.stringify({ items: { "https://github.com/o/r/pull/9": { state: "silenced", at: T0 } } }));
    expect(listedUrls()).toEqual(new Set([URL_A, URL_B]));
    toggleSilence({ url: "https://github.com/o/r/issues/77" }, new Date(T1));
    expect([...readStore().keys()]).toEqual(["https://github.com/o/r/issues/77"]);
  });

  test("a scan of the same items is skipped while it is young; an update or age scans again", () => {
    let scans = 0;

    const runner = (cmd: string[]): RunResult => {
      if (!cmd.includes("user")) scans++;

      return cmd.includes("user") ? ok("me\n") : ok(JSON.stringify({ data: { m0: null } }));
    };

    refreshMentions(1_000, runner);
    expect(scans).toBe(1);
    expect(refreshMentions(2_000, runner).at).toBe(1_000);
    expect(scans).toBe(1);
    writeFileSync(join(tmp, ".overbridge", "prlist-reviews.json"), JSON.stringify({ at: 1, rows: [pr({ group: "team", seenAt: T0, updatedAt: T2 })] }));
    refreshMentions(3_000, runner);
    expect(scans).toBe(2);
    refreshMentions(3_000 + MENTION_MAX_AGE_MS, runner);
    expect(scans).toBe(3);
    expect(mentionSignature([URL_A], [pr({ updatedAt: T2 })])).toBe(`${URL_A} ${T2}`);
  });

  test("a failed scan keeps the last mentions and records why", () => {
    writeFileSync(join(tmp, ".overbridge", "mentions.json"), JSON.stringify({ at: 1, mentions: { [URL_A]: T1 } }));
    const cache = refreshMentions(5, () => ({ ok: false, code: 1, stdout: "", stderr: "offline" }));
    expect(cache).toEqual({ at: 5, mentions: new Map([[URL_A, T1]]), error: "gh api user failed: offline" });
    expect(mentionScanError()).toBe("error: mention scan failed: gh api user failed: offline");
    refreshMentions(6, (cmd) => ok(cmd.includes("user") ? "me\n" : JSON.stringify({ data: {} })));
    expect(mentionScanError()).toBe("");
  });
});

describe("toggleMessage", () => {
  let tmp: string;
  const savedRoot = process.env.OVERBRIDGE_ROOT;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "overbridge-silence-msg-"));
    process.env.OVERBRIDGE_ROOT = tmp;
  });

  afterEach(() => {
    if (savedRoot === undefined) delete process.env.OVERBRIDGE_ROOT;
    else process.env.OVERBRIDGE_ROOT = savedRoot;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("names the new state, or the write error", () => {
    expect(toggleMessage({ url: URL_A }, "o/r#1")).toBe("silenced o/r#1");
    // a root that is a file makes the store's folder impossible to create
    writeFileSync(join(tmp, "blocker"), "");
    process.env.OVERBRIDGE_ROOT = join(tmp, "blocker");
    expect(toggleMessage({ url: URL_A }, "o/r#1")).toStartWith("error: could not save the silence for o/r#1:");
  });
});
