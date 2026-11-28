import { describe, expect, test } from "bun:test";
import { DEFAULT_LEADER, parseLeader, tmuxKey, tmuxLeaderLines, zellijKey, zellijKeybinds } from "../src/leader";
import { allBindings, PRESS_KEYS, RESERVED_KEYS } from "../src/keys";
import { drainPresses, isPressKey, parsePresses, PRESS_MAX_AGE_MS, pressKey, topPress } from "../src/top-press";

describe("parsePresses", () => {
  test("keeps fresh valid keys in order and drops stale, unknown and malformed lines", () => {
    const now = 100_000;
    const text = [`${now - 10} i`, `${now - PRESS_MAX_AGE_MS - 1} p`, `${now} q`, `${now} xx`, "junk", `${now - 5} 3`, ""].join("\n");

    expect(parsePresses(text, now)).toEqual(["i", "3"]);
  });
});

describe("press keys", () => {
  test("never take a key of the shared table or the panel's reserved ones, except the panel's own r and o", () => {
    const table = new Set(allBindings().flatMap(([, keys]) => keys));

    for (const k of PRESS_KEYS) {
      if (k === "r" || k === "o") continue;
      expect(table.has(k)).toBe(false);
    }

    expect(RESERVED_KEYS.has("q")).toBe(true);
    expect(isPressKey("q")).toBe(false);
  });
});

describe("the press queue", () => {
  test("a press is delivered once to the tab it was made for", () => {
    pressKey("tab-a", "m");
    pressKey("tab-a", "1");
    pressKey("tab-b", "i");
    expect(drainPresses("tab-a")).toEqual(["m", "1"]);
    expect(drainPresses("tab-a")).toEqual([]);
    expect(drainPresses("tab-b")).toEqual(["i"]);
  });

  test("a stale press is dropped", () => {
    pressKey("tab-c", "i", Date.now() - PRESS_MAX_AGE_MS - 1_000);
    expect(drainPresses("tab-c")).toEqual([]);
  });

  test("an unknown key is refused", () => {
    expect(() => pressKey("tab-d", "q")).toThrow("not a button key");
  });

  test("topPress uses --ws, else the multiplexer's current tab, and refuses with neither", () => {
    const mux = { currentTab: () => "tab-e" };
    topPress("e", undefined, mux);
    topPress("t", "tab-f", mux);
    expect(drainPresses("tab-e")).toEqual(["e"]);
    expect(drainPresses("tab-f")).toEqual(["t"]);
    expect(() => topPress("e", undefined, { currentTab: () => undefined })).toThrow("not on a tab");
    expect(() => topPress(undefined, undefined, mux)).toThrow("usage");
  });
});

describe("leader", () => {
  test("parses ctrl- and alt- with space or a letter, and nothing else", () => {
    expect(parseLeader(DEFAULT_LEADER)).toEqual({ mod: "ctrl", key: "space" });
    expect(parseLeader("Alt-X")).toEqual({ mod: "alt", key: "x" });
    expect(parseLeader("super-a")).toBeUndefined();
    expect(parseLeader("ctrl-")).toBeUndefined();
    expect(parseLeader("ctrl-ab")).toBeUndefined();
  });

  test("names the key for each multiplexer", () => {
    expect(tmuxKey({ mod: "ctrl", key: "space" })).toBe("C-Space");
    expect(tmuxKey({ mod: "alt", key: "x" })).toBe("M-x");
    expect(zellijKey({ mod: "ctrl", key: "space" })).toBe("Ctrl Space");
    expect(zellijKey({ mod: "alt", key: "x" })).toBe("Alt x");
  });

  test("tmux binds the leader to a key table with one binding per press key", () => {
    const lines = tmuxLeaderLines(["ob"], { mod: "ctrl", key: "space" });

    expect(lines[0]).toBe("bind -n C-Space switch-client -T overbridge");
    expect(lines).toHaveLength(1 + PRESS_KEYS.length);
    expect(lines).toContain('bind -T overbridge D run-shell -b "ob top press D"');
  });

  test("zellij binds the leader to the tmux mode and each press key to a run", () => {
    const kdl = zellijKeybinds(["ob"], { mod: "alt", key: "x" });

    expect(kdl).toContain('bind "Alt x" { SwitchToMode "tmux"; }');
    expect(kdl).toContain('bind "C" { Run "ob" "top" "press" "C" { close_on_exit true; floating true; }; SwitchToMode "normal"; }');
  });
});
