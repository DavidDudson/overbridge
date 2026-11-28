import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { leaderKey } from "../src/config";
import { chooseLayout } from "../src/layout";
import { reposFile } from "../src/paths";

let tmp: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-leader-"));
  process.env.OVERBRIDGE_ROOT = tmp;
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.OVERBRIDGE_ROOT;
  else process.env.OVERBRIDGE_ROOT = savedRoot;
  rmSync(tmp, { recursive: true, force: true });
});

describe("[keys] leader", () => {
  test("defaults to ctrl-space", () => {
    expect(leaderKey()).toEqual({ mod: "ctrl", key: "space" });
  });

  test("is read from repos.toml and reaches the tmux config", () => {
    writeFileSync(reposFile(), '[keys]\nleader = "alt-x"\n');
    expect(leaderKey()).toEqual({ mod: "alt", key: "x" });
    const choice = chooseLayout(["w1"], ["ob"], "tmux", "s", join(tmp, "none.kdl"));

    expect(choice.source === "generated" && choice.conf).toContain("bind -n M-x switch-client -T overbridge");
  });

  test("a bad value is refused by leaderKey, but never stops the layout", () => {
    writeFileSync(reposFile(), '[keys]\nleader = "hyper-z"\n');
    expect(() => leaderKey()).toThrow("keys.leader");
    const choice = chooseLayout(["w1"], ["ob"], "tmux", "s", join(tmp, "none.kdl"));

    expect(choice.source === "generated" && choice.conf).toContain("bind -n C-Space switch-client -T overbridge");
  });

  test("off binds no chord", () => {
    writeFileSync(reposFile(), '[keys]\nleader = "off"\n');
    expect(leaderKey()).toBeNull();
    const choice = chooseLayout(["w1"], ["ob"], "tmux", "s", join(tmp, "none.kdl"));

    expect(choice.source === "generated" && choice.conf).not.toContain("switch-client -T overbridge");
  });
});
