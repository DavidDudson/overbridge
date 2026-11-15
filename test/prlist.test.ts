import { describe, expect, test } from "bun:test";
import { age, readPrs, renderPrList, rowsFromSearch, searchCommand } from "../src/prlist-run";

const hit = { number: 7, title: "Fix", url: "https://github.com/o/r/pull/7", repository: { nameWithOwner: "o/r" }, author: { login: "a" }, isDraft: false, updatedAt: "2026-11-11T00:00:00Z" };

describe("pr lists", () => {
  test("search command scopes to orgs and the list kind", () => {
    const mine = searchCommand("prs", ["DavidDudson", "megaport"]);
    expect(mine).toContain("--author=@me");
    expect(mine).toContain("--owner=DavidDudson");
    expect(mine).toContain("--owner=megaport");
    expect(searchCommand("reviews", [])).toContain("--review-requested=@me");
    expect(searchCommand("reviews", []).some((a) => a.startsWith("--owner"))).toBe(false);
  });
  test("rows from gh output", () => {
    expect(rowsFromSearch(JSON.stringify([hit]))[0]).toMatchObject({ repo: "o/r", number: 7, author: "a", draft: false });
  });
  test("failed gh throws its first line", () => {
    expect(() => readPrs("prs", [], () => ({ ok: false, code: 1, stdout: "", stderr: "boom\nmore" }))).toThrow("boom");
  });
  test("age", () => {
    const now = Date.parse("2026-11-11T03:00:00Z");
    expect(age("2026-11-11T00:00:00Z", now)).toBe("3h");
    expect(age("nope", now)).toBe("");
  });
  test("render marks selection and empty state", () => {
    expect(renderPrList("reviews", [], 0, 0, 10, 80).join("\n")).toContain("nothing asked of you directly");
    expect(renderPrList("prs", rowsFromSearch(JSON.stringify([hit])), 0, 0, 10, 80).join("\n")).toContain("o/r");
  });
});

import { mergeRows, filterOrgs, requestedOf, rowFromNode, rowsFromReviews, searchString } from "../src/review-batch";
import { allocate, cellsFor, columnsFor, split, windowStart } from "../src/reviews-view";
import { textWidth } from "../src/term";

const node = (over: object = {}) => ({
  number: 9, title: "Add thing", url: "https://github.com/DavidDudson/r/pull/9", isDraft: false, updatedAt: "2026-11-11T00:00:00Z",
  mergeable: "CONFLICTING", reviewDecision: "REVIEW_REQUIRED", author: { login: "bob" }, repository: { nameWithOwner: "DavidDudson/r" },
  reviewRequests: { nodes: [{ requestedReviewer: { __typename: "Team", slug: "core", organization: { login: "DavidDudson" } } }, { requestedReviewer: { __typename: "Bot", login: "copilot-pull-request-reviewer" } }] },
  latestReviews: { nodes: [] }, comments: { nodes: [] }, reviewThreads: { nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE", contexts: { nodes: [] } } } }] },
  ...over,
});

describe("reviews data", () => {
  test("search string scopes to me and the org", () => {
    expect(searchString("me", "DavidDudson")).toContain("review-requested:me org:DavidDudson");
    expect(searchString("me")).not.toContain("org:");
  });
  test("a team request is a team row; naming me makes it direct", () => {
    const team = rowFromNode(node() as never, "me");
    expect(team).toMatchObject({ group: "team", via: "DavidDudson/core", mergeable: "CONFLICTING", ci: "failure", decision: "REVIEW_REQUIRED" });
    expect(team.bots?.find((b) => b.name === "Copilot")?.state).toBe("reviewing");
    const direct = { reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "Me" } }] } };
    expect(rowFromNode(node(direct) as never, "me").group).toBe("direct");
    expect(requestedOf(node(direct) as never, "me")).toEqual({ direct: true, teams: [] });
  });
  test("rows from a response, deduped and filtered to the org", () => {
    const json = JSON.stringify({ data: { search: { nodes: [node(), {}, node({ number: 10, url: "https://github.com/other/x/pull/10", repository: { nameWithOwner: "other/x" } })] } } });
    const rows = rowsFromReviews(json, "me");
    expect(rows).toHaveLength(2);
    expect(mergeRows([rows, rows])).toHaveLength(2);
    expect(filterOrgs(rows, ["DavidDudson"]).map((r) => r.number)).toEqual([9]);
    expect(filterOrgs(rows, [])).toHaveLength(2);
  });
  test("readPrs reviews: one search per org, login first", () => {
    const calls: string[][] = [];
    const rows = readPrs("reviews", ["DavidDudson"], (cmd) => {
      calls.push(cmd);

      return { ok: true, code: 0, stdout: cmd[2] === "user" ? "me\n" : JSON.stringify({ data: { search: { nodes: [node()] } } }), stderr: "" };
    });
    expect(rows).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.join(" ")).toContain("org:DavidDudson");
  });
});

describe("reviews view", () => {
  const mk = (n: number, group: "direct" | "team") => ({ ...rowFromNode(node({ number: n }) as never, "me"), group });

  test("split and allocation", () => {
    expect(split([mk(1, "direct"), mk(2, "team"), mk(3, "team")])).toMatchObject({ direct: [{ number: 1 }], team: [{ number: 2 }, { number: 3 }] });
    expect(allocate(2, 3, 20)).toEqual({ direct: 2, team: 3 });
    expect(allocate(0, 0, 20)).toEqual({ direct: 1, team: 1 });
    expect(allocate(1, 30, 10)).toEqual({ direct: 1, team: 9 });
    expect(allocate(30, 30, 10)).toEqual({ direct: 5, team: 5 });
    expect(windowStart(30, 20, 10)).toBe(15);
    expect(windowStart(5, 4, 10)).toBe(0);
  });
  test("narrow panes drop optional columns, never the repo or the bots", () => {
    const keys = columnsFor(70).map((c) => c.key);
    expect(keys).toContain("copilot");
    expect(keys).toContain("rabbit");
    expect(keys).not.toContain("author");
    expect(columnsFor(200).map((c) => c.key)).toContain("author");
  });
  test("conflict shows and pulses", () => {
    const r = mk(1, "direct");
    expect(cellsFor(r, 0, true).merge).toMatchObject({ color: "red" });
    expect(cellsFor(r, 0, true).merge.text).toContain("💥");
    expect(cellsFor(r, 600, true).merge.text).toContain("🔥");
    expect(cellsFor(r, 600, false).merge.text).toContain("💥");
  });
  test("both tables share column positions and fill the screen", () => {
    const rows = [mk(1, "direct"), mk(2, "team")];
    const out = renderPrList("reviews", rows, 0, 0, 24, 120);
    expect(out).toHaveLength(24);
    expect(out.every((l) => textWidth(l.replace(/\x1b\[[0-9;]*m/g, "")) === 120)).toBe(true);
    const plain = out.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
    const headers = plain.filter((l) => l.includes("copilot"));
    expect(headers).toHaveLength(2);
    expect(headers[0]!.indexOf("copilot")).toBe(headers[1]!.indexOf("copilot"));
    expect(plain.join("\n")).toContain("Asked of my teams");
    expect(plain.join("\n")).toContain("core");
  });
  test("empty tables say so", () => {
    const text = renderPrList("reviews", [], 0, 0, 20, 100).join("\n");
    expect(text).toContain("nothing asked of you directly");
    expect(text).toContain("nothing asked of your teams");
  });
});
