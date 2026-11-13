import { describe, expect, test } from "bun:test";
import { createHandler } from "../src/server";
import { createWorklistRefresher } from "../src/server-worklist";
import type { WorkRow } from "../src/pm/worklist";
import { type BoardSource, boardSources, refreshWorklistAny, sourceKey, type SourceRead } from "../src/worklist-run";

const row = (repo: string, id: string): WorkRow => ({ repo, id, title: `t${id}`, url: "u", status: "todo", labels: [], blockedBy: [], updatedAt: "2026-01-01T00:00:00Z" }) as WorkRow;
const gh = (repo: string, slug = `o/${repo}`): BoardSource => ({ kind: "github", repo, slug });
const jira = (project: string, repos: string[], filter?: string): BoardSource => ({ kind: "jira", project, repos, ...(filter ? { filter } : {}) });

describe("sourceKey", () => {
  test("repos on one Jira project and filter share a key, a different filter or project does not", () => {
    const { sources } = boardSources([
      { repo: "a", url: "x", pm: { name: "jira", project: "ENG" } },
      { repo: "b", url: "x", pm: { name: "jira", project: "eng" } },
      { repo: "c", url: "x", pm: { name: "jira", project: "ENG", worklistJql: "labels = x" } },
    ]);
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map(sourceKey)).size).toBe(2);
    expect(sourceKey(jira("ENG", ["a"]))).toBe(sourceKey(jira("ENG", ["a", "b"])));
  });

  test("a GitHub board is keyed by repo and by what shapes its rows", () => {
    expect(sourceKey(gh("a"))).toBe(sourceKey(gh("a")));
    expect(sourceKey(gh("a"))).not.toBe(sourceKey(gh("b")));
    expect(sourceKey(gh("a", "o/x"))).not.toBe(sourceKey(gh("b", "o/x")));
    expect(sourceKey({ kind: "github", repo: "a", slug: "o/a", scope: "all" })).not.toBe(sourceKey(gh("a")));
  });
});

describe("worklist refresher", () => {
  const setup = (sources: BoardSource[], over: { fail?: Set<string> } = {}) => {
    const reads: string[] = [];
    const written: SourceRead[] = [];
    let t = 0;
    const r = createWorklistRefresher({
      now: () => t,
      plan: async () => ({ sources, notes: ["plan note"] }),
      read: async (s) => {
        reads.push(sourceKey(s));
        if (over.fail?.has(s.kind === "github" ? s.repo : s.project)) throw new Error("rate limited\nmore");
        return { rows: [row(s.kind === "github" ? s.repo : s.repos[0]!, "1")], notes: [], failedRepos: [] };
      },
      finish: (_notes, read) => void written.push(read),
    });
    return { r, reads, written, advance: (ms: number) => (t += ms) };
  };

  test("every board is read once per window, however many panes refresh", async () => {
    const { r, reads, written } = setup([gh("a"), jira("ENG", ["x", "y"])]);
    await Promise.all([r.refresh(), r.refresh(), r.refresh()]);
    await r.refresh();
    expect(reads).toHaveLength(2);
    expect(written).toHaveLength(1);
    expect(written[0]!.rows.map((x) => x.repo).sort()).toEqual(["a", "x"]);
  });

  test("a failed plan after a good run answers the old time with the error, so the route can say 502", async () => {
    let plans = 0;
    const r = createWorklistRefresher({
      now: () => 0,
      plan: async () => (++plans > 1 ? Promise.reject(new Error("git exploded")) : { sources: [], notes: [] }),
      read: async () => ({ rows: [], notes: [], failedRepos: [] }),
      finish: () => {},
    });
    expect((await r.refresh()).error).toBeUndefined();
    expect((await r.refresh(true)).error).toContain("git exploded");
  });

  test("a new window reads again, and force reads inside the window", async () => {
    const { r, reads, advance } = setup([gh("a")]);
    await r.refresh();
    advance(61_000);
    await r.refresh();
    await r.refresh(true);
    expect(reads).toHaveLength(3);
  });

  test("a failed read is not cached as a good one: the last good read is served with a note, and the next window retries", async () => {
    let failing = false;
    let t = 0;
    const written: SourceRead[] = [];
    const reads: number[] = [];
    const r = createWorklistRefresher({
      now: () => t,
      plan: async () => ({ sources: [gh("a")], notes: [] }),
      read: async () => (reads.push(t), failing ? { rows: [], notes: ["a: rate limited"], failedRepos: ["a"] } : { rows: [row("a", "1")], notes: [], failedRepos: [] }),
      finish: (_n, read) => void written.push(read),
    });
    await r.refresh();
    failing = true;
    t += 61_000;
    await r.refresh();
    expect(written[1]!.rows.map((x) => x.id)).toEqual(["1"]);
    expect(written[1]!.notes[0]).toContain("rate limited");
    failing = false;
    t += 61_000 + 15_000;
    await r.refresh();
    expect(written[2]!.notes).toEqual([]);
    expect(reads).toHaveLength(3);
  });

  test("a failing board is a note and a failed repo for the rest to carry on, not an error", async () => {
    const { r, written } = setup([gh("a"), gh("b")], { fail: new Set(["b"]) });
    await r.refresh();
    expect(written[0]!.rows.map((x) => x.repo)).toEqual(["a"]);
    expect(written[0]!.notes).toEqual(["b: rate limited"]);
    expect(written[0]!.failedRepos).toEqual(["b"]);
  });
});

describe("worklist route and fallback", () => {
  test("POST /refresh/worklist answers with when it ran; with no refresher the route is not found", async () => {
    const deps = { refreshTop: async () => ({ links: [], at: 0 }), refreshPerf: async () => 0, workspaceExists: () => true, cacheFileAt: () => 0, version: "v", onVersionMismatch: () => undefined };
    const calls: boolean[] = [];
    const h = createHandler({ ...deps, refreshWorklist: async (force) => (calls.push(force), 42) });
    const res = await h.handle(new Request("http://x/refresh/worklist?force=1", { method: "POST" }));
    expect(await res.json()).toEqual({ served: 42 });
    expect(calls).toEqual([true]);
    expect((await createHandler(deps).handle(new Request("http://x/refresh/worklist", { method: "POST" }))).status).toBe(404);
  });

  test("the pane refreshes through the server and spawns no child, or falls back to one when none answers", async () => {
    let children = 0;
    const child = async () => (children++, { ok: true, error: "" });
    expect(await refreshWorklistAny({}, async () => ({ ok: false, error: "boom" }), child)).toEqual({ ok: false, error: "boom" });
    expect(children).toBe(0);
    expect(await refreshWorklistAny({}, async () => undefined, child)).toEqual({ ok: true, error: "" });
    expect(children).toBe(1);
  });
});
