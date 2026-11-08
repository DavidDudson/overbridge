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

  test("structure: every tab is sidebar | (top panel over agent over shell)", () => {
    const kdl = layoutKdl(["a", "b", "c"], ["overbridge"]);
    const tabs = kdl.split(/\n(?=  tab )/).slice(1);
    expect(tabs).toHaveLength(3);
    for (const tab of tabs) {
      const order = [...tab.matchAll(/pane name="([^"]+)"/g)].map((m) => m[1]!.replace(/^\w+ · /, ""));
      expect(order).toEqual(["sidebar", "top", "claude", "shell"]);
    }
  });
});
