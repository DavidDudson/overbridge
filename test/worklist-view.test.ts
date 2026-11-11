import { describe, expect, test } from "bun:test";
import { rank, type WorkRow } from "../src/pm/worklist";
import type { ProjectManagement } from "../src/project-config";
import { boardSources, keepLastGood, pickRepo, readBoards, refreshInChild, renderWorklist, repoPrompt, showWorklist } from "../src/worklist-run";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const row = (id: string, o: Partial<WorkRow> = {}): WorkRow => ({
  repo: "ob",
  id,
  title: `title ${id}`,
  url: `u${id}`,
  status: "todo",
  labels: [],
  blockedBy: [],
  updatedAt: `2026-01-0${id}T00:00:00Z`,
  ...o,
});

describe("renderWorklist", () => {
  const list = rank([row("1", { labels: ["p0"] }), row("2", { blockedBy: ["ob#1"] }), row("3", { status: "in-progress" })]);

  test("rows fit the width and the height", () => {
    const rows = renderWorklist(list, 0, 0, 12, 60);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => strip(r).length <= 60)).toBe(true);
  });

  test("lists items in rank order with readiness, and explains the selected one", () => {
    const rows = renderWorklist(list, 0, 0, 12, 70).map(strip);
    expect(rows[2]).toMatch(/1\s+yes\s+s1\s+ob#1\s+title 1/);
    expect(rows[3]).toMatch(/2\s+no\s+s1\s+ob#2/);
    expect(rows.find((r) => r.includes("why:"))).toContain("ready, priority p0, unblocks 1");
  });

  test("says so when nothing is assigned", () => {
    expect(renderWorklist([], 0, 0, 12, 60).map(strip).join("\n")).toContain("nothing assigned to you");
  });

  test("scrolls with the offset", () => {
    const rows = renderWorklist(list, 2, 1, 8, 70).map(strip);
    expect(rows.join("\n")).toContain("ob#2");
    expect(rows.join("\n")).not.toContain("title 1");
  });
});

describe("board sources", () => {
  const jira = (project: string, extra: Partial<ProjectManagement> = {}): ProjectManagement => ({ name: "jira", project, ...extra });

  test("repos on one Jira project share one read; GitHub repos read alone", () => {
    const { sources, notes } = boardSources([
      { repo: "web", url: "git@github.com:o/web.git", pm: jira("abc") },
      { repo: "api", url: "git@github.com:o/api.git", pm: jira("ABC") },
      { repo: "ops", url: "git@github.com:o/ops.git", pm: jira("ABC", { worklistJql: "" }) },
      { repo: "ob", url: "git@github.com:o/ob.git", pm: { name: "github", project: "o/ob" } },
      { repo: "odd", url: "/local/odd", pm: { name: "github", project: "7" } },
      { repo: "none", url: "git@github.com:o/none.git" },
    ]);
    expect(sources).toEqual([
      { kind: "github", repo: "ob", slug: "o/ob" },
      { kind: "jira", project: "ABC", repos: ["web", "api"] },
      { kind: "jira", project: "ABC", repos: ["ops"], filter: "" },
    ]);
    expect(notes).toEqual(["odd: cannot tell the GitHub repo from /local/odd"]);
  });

  test("a failing source adds a note and the rest still read", () => {
    const out = readBoards(
      [
        { kind: "jira", project: "ABC", repos: ["web"], site: "https://x" },
        { kind: "github", repo: "ob", slug: "o/ob" },
      ],
      {
        jira: (project, repos, opts) => {
          expect(opts).toEqual({ site: "https://x" });
          throw new Error(`jira: reading ${project} for ${repos.join()} failed\nmore`);
        },
        github: (_slug, repo) => [row("1", { repo })],
      },
    );
    expect(out.rows.map((r) => r.id)).toEqual(["1"]);
    expect(out.notes).toEqual(["ABC: jira: reading ABC for web failed"]);
  });
});

describe("repo picker", () => {
  test("digits pick one of the offered repos, anything else does not", () => {
    expect(pickRepo("2", ["web", "api"])).toBe("api");
    expect(pickRepo("3", ["web", "api"])).toBeUndefined();
    expect(pickRepo("0", ["web"])).toBeUndefined();
    expect(pickRepo("s", ["web"])).toBeUndefined();
  });

  test("the prompt numbers the repos", () => {
    expect(repoPrompt("ABC-1", ["web", "api"])).toBe("start ABC-1 in: 1 web  2 api   esc cancel");
  });
});

describe("refreshInChild", () => {
  test("runs `worklist refresh` under the self command and reports success", async () => {
    const calls: string[][] = [];
    const result = await refreshInChild(async (cmd) => {
      calls.push(cmd);
      return { code: 0, stderr: "worklist: 3 open item(s)\n" };
    }, ["ob"]);
    expect(calls).toEqual([["ob", "worklist", "refresh"]]);
    expect(result).toEqual({ ok: true, error: "" });
  });

  test("a failing child reports its first stderr line, or its exit code when it printed nothing", async () => {
    expect(await refreshInChild(async () => ({ code: 1, stderr: "\noverbridge: config.yml: bad key\nmore\n" }), ["ob"])).toEqual({ ok: false, error: "overbridge: config.yml: bad key" });
    expect(await refreshInChild(async () => ({ code: 137, stderr: "" }), ["ob"])).toEqual({ ok: false, error: "worklist refresh exited with code 137" });
  });
});

describe("last good cache", () => {
  test("a failed repo keeps its previous rows; a read one is replaced", () => {
    const prev = [row("1", { repo: "a" }), row("2", { repo: "b" })];
    const out = keepLastGood(prev, [row("3", { repo: "b" })], ["a"]);
    expect(out.map((r) => `${r.repo}#${r.id}`).sort()).toEqual(["a#1", "b#3"]);
  });

  test("a failing reader is reported with its repos and adds no rows", () => {
    const r = readBoards([{ kind: "github", repo: "a", slug: "o/a" }], { github: () => { throw new Error("API rate limit exceeded\nmore"); }, jira: () => [] });
    expect(r).toEqual({ rows: [], notes: ["a: API rate limit exceeded"], failedRepos: ["a"] });
  });

  test("the panel shows the error and says the list is the last good one", () => {
    const text = renderWorklist(rank([row("1")]), 0, 0, 12, 100, "", ["a: API rate limit exceeded"]).map(strip).join("\n");
    expect(text).toContain("error: a: API rate limit exceeded");
    expect(text).toContain("last good list");
  });
});

describe("showWorklist", () => {
  test("prints ranked rows, tab separated, then the notes", () => {
    const lines = showWorklist({ at: 0, rows: [row("2", { blockedBy: ["ob#1"] }), row("1", { labels: ["p0"] })], notes: ["jira X: down"] });
    expect(lines[0]).toBe("1\tready\tob#1\ttitle 1\tready, priority p0, unblocks 1");
    expect(lines[1]).toContain("2\ttodo\tob#2");
    expect(lines[2]).toBe("note: jira X: down");
  });

  test("says so when nothing is assigned", () => {
    expect(showWorklist({ at: 0, rows: [], notes: [] })).toEqual(["nothing assigned to you"]);
  });
});
