import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { layoutKdl } from "../src/layout";

// A fixed root keeps the snapshot independent of the machine it runs on.
const saved = process.env.OVERBRIDGE_ROOT;

beforeAll(() => void (process.env.OVERBRIDGE_ROOT = "/ws-root"));

afterAll(() => (saved === undefined ? delete process.env.OVERBRIDGE_ROOT : void (process.env.OVERBRIDGE_ROOT = saved)));

describe("generated layout", () => {
  test("two workspaces, one resuming", () => {
    expect(layoutKdl(["ws1", "ws2"], ["overbridge"], { resume: new Set(["ws2"]) })).toMatchSnapshot();
  });

  test("a wide sidebar and a self command with arguments", () => {
    expect(layoutKdl(["ws1"], ["/usr/bin/bun", "/opt/overbridge/src/cli.ts"], { sidebarWidth: 40 })).toMatchSnapshot();
  });

  test("structure: the orchestration tab is sidebar | agent, every workspace tab sidebar | (top panel over agent)", () => {
    const kdl = layoutKdl(["a", "b", "c"], ["overbridge"]);
    const names = (tab: string) => [...tab.matchAll(/pane name="([^"]+)"/g)].map((m) => m[1]!).filter((n) => !n.includes(" · frame "));
    const [orchestration, work, prs, reviews, perf, checks, frozen, explore, ...tabs] = kdl.split(/\n(?=  tab )/).slice(1);
    expect(names(orchestration!)).toEqual(["sidebar", "@root · claude"]);
    expect(names(work!)).toEqual(["sidebar", "@work · worklist"]);
    expect(names(prs!)).toEqual(["sidebar", "@prs · prs"]);
    expect(names(reviews!)).toEqual(["sidebar", "@reviews · reviews"]);
    expect(names(perf!)).toEqual(["sidebar", "@perf · perf"]);
    expect(names(checks!)).toEqual(["sidebar", "@checks · checks"]);
    expect(names(frozen!)).toEqual(["sidebar", "@frozen · frozen"]);
    expect(names(explore!)).toEqual(["sidebar", "@explore · explore"]);
    expect(tabs).toHaveLength(3);

    for (const tab of tabs) {
      const order = names(tab).map((n) => n.replace(/^\w+ · /, ""));
      expect(order).toEqual(["sidebar", "top", "claude", "diff"]);
    }
  });
});
