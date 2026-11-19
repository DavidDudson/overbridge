import { describe, expect, test } from "bun:test";
import type { CiState } from "../src/pr-look";
import { readPrs } from "../src/prlist-run";
import { textWidth } from "../src/term";
import { botIcon, decisionIcon, prsView } from "../src/prs-view";
import { graphqlCommand, readMyPrs, rowsFromGraphql, searchQuery } from "../src/prs-refresh";

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const node = (over: { number?: number; mergeable?: string; title?: string } = {}) => ({
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
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] },
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

describe("my PRs read, edge cases", () => {
  test.each<[string, CiState]>([
    ["FAILURE", "failure"],
    ["ERROR", "failure"],
    ["PENDING", "pending"],
    ["SUCCESS", "success"],
  ])("GitHub rollup %s shows as %s", (state, expected) => {
    const withState = { ...node(), commits: { nodes: [{ commit: { statusCheckRollup: { state, contexts: { nodes: [] } } } }] } };
    expect(rowsFromGraphql(reply(withState))[0]!.ci).toBe(expected);
  });
  test("readPrs routes prs through the GraphQL read", () => {
    const calls: string[][] = [];

    const rows = readPrs("prs", [], (cmd) => {
      calls.push(cmd);

      return { ok: true, code: 0, stdout: reply(node()), stderr: "" };
    });

    expect(rows).toHaveLength(1);
    expect(calls[0]!.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
  });
  test("one page of 100, and a failure with no output still names the exit code", () => {
    expect(graphqlCommand([]).join(" ")).toContain("first:100");
    expect(() => readMyPrs([], () => ({ ok: false, code: 4, stdout: "", stderr: "" }))).toThrow("exit 4");
  });
  test("control characters in API text never reach a row", () => {
    const [row] = rowsFromGraphql(reply(node({ title: "evil\x1b]0;x\x07title" })));
    expect(row!.title).toBe("evil]0;xtitle");
  });
});

describe("sized reads", () => {
  test("the full read asks for the page it is given", () => {
    expect(graphqlCommand([], 7).join(" ")).toContain("first:7");
  });
});
