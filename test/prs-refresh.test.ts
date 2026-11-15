import { describe, expect, test } from "bun:test";
import { textWidth } from "../src/term";
import { botIcon, decisionIcon, prsView } from "../src/prs-view";
import { ciOf, graphqlCommand, readMyPrs, rowsFromGraphql, searchQuery } from "../src/prs-refresh";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const node = (over: Record<string, unknown> = {}) => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  title: "Fix",
  isDraft: false,
  updatedAt: "2026-11-11T00:00:00Z",
  state: "OPEN",
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  author: { login: "a" },
  repository: { nameWithOwner: "o/r" },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] },
  latestReviews: { nodes: [{ author: { login: "copilot-pull-request-reviewer" }, state: "COMMENTED", url: "u" }] },
  ...over,
});

const reply = (...nodes: unknown[]) => JSON.stringify({ data: { search: { nodes } } });

describe("my PRs read", () => {
  test("search scopes to author, state and orgs", () => {
    expect(searchQuery(["DavidDudson"])).toBe("is:pr is:open author:@me user:DavidDudson sort:updated-desc");
    expect(searchQuery([])).not.toContain("user:");
    expect(graphqlCommand([]).join(" ")).toContain("q=is:pr is:open author:@me");
  });
  test("a row carries merge state, checks, decision and bots", () => {
    const [row] = rowsFromGraphql(reply(node()));
    expect(row).toMatchObject({ repo: "o/r", number: 7, mergeable: "MERGEABLE", ci: "success", decision: "APPROVED", draft: false });
    expect(row!.bots?.find((b) => b.name === "Copilot")?.state).toBe("reviewed");
  });
  test("checks fold to one state, failure first", () => {
    expect(ciOf([])).toBe("none");
    expect(ciOf([{ conclusion: "SUCCESS" }, { conclusion: "FAILURE" }])).toBe("failure");
    expect(ciOf([{ status: "IN_PROGRESS" }, { conclusion: "SUCCESS" }])).toBe("pending");
    expect(ciOf([{ conclusion: "SUCCESS" }])).toBe("success");
  });
  test("a reply with no search is a failure; gh stderr wins when there is no data", () => {
    expect(() => rowsFromGraphql("{}")).toThrow();
    expect(() => readMyPrs([], () => ({ ok: false, code: 1, stdout: "", stderr: "boom\nmore" }))).toThrow("boom");
  });
  test("a node with errors but data still reads", () => {
    expect(readMyPrs([], () => ({ ok: false, code: 1, stdout: reply(node(), null), stderr: "partial" }))).toHaveLength(1);
  });
});

describe("my PRs view", () => {
  const rows = rowsFromGraphql(reply(node(), node({ number: 8, mergeable: "CONFLICTING" })));
  const ui = { selected: 0, offset: 0, height: 12, width: 90, message: "", now: 0 };

  test("a conflict shows, pulses between two glyphs and animates the pane", () => {
    expect(prsView.animated(rows)).toBe(true);
    expect(prsView.animated([rows[0]!])).toBe(false);
    const a = prsView.render(rows, { ...ui, now: 0 }).map(strip).join("\n");
    const b = prsView.render(rows, { ...ui, now: 500 }).map(strip).join("\n");
    expect(a).toContain("💥");
    expect(b).toContain("🔥");
    expect(a).toContain("1 conflicting");
  });
  test("glyphs", () => {
    expect(decisionIcon("APPROVED")).toBe("✅");
    expect(decisionIcon("")).toBe("·");
    expect(botIcon(undefined, "CodeRabbit")).toBe("·");
  });
  test("rows keep one width", () => {
    const widths = new Set(prsView.render(rows, ui).map((l) => textWidth(strip(l))));
    expect(widths.size).toBe(1);
  });
});
