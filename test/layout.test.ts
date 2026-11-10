import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ORCHESTRATION_TABS } from "../src/orchestration";
import { root, wsDir } from "../src/paths";
import { chooseLayout, layoutKdl, newTabKdl, resumable, SIDEBAR_WIDTH, TOP_ROWS, transcriptDir, userLayoutPath, zellijConfigDir } from "../src/layout";

const self = ["overbridge"];
const tabs = (kdl: string) => kdl.match(/\btab name=/g)?.length ?? 0;

let tmp: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-layout-"));
  process.env.OVERBRIDGE_ROOT = tmp;
});

afterEach(() => {
  savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
  rmSync(tmp, { recursive: true, force: true });
});

describe("layoutKdl", () => {
  test("one tab per workspace, however many there are, after the orchestration tabs", () => {
    for (const n of [0, 1, 4, 5, 9]) expect(tabs(layoutKdl(Array.from({ length: n }, (_, i) => `w${i}`), self))).toBe(n + ORCHESTRATION_TABS.length);
  });

  test("the root orchestration tab comes first and has focus: sidebar and Claude in the root, no top panel", () => {
    const kdl = layoutKdl(["a", "b"], self);
    const [first, ...rest] = kdl.split(/\n(?=  tab )/).slice(1);
    expect(first).toStartWith('  tab name="@root" focus=true {');
    expect(first).toContain(`cwd=${JSON.stringify(root())}`);
    expect(first).toContain('args "sidebar" "--ws" "@root"');
    expect(first).toContain('args "claude" "@root"\n');
    expect(first).not.toContain('"top"');
    for (const tab of rest) expect(tab.split("\n")[0]).not.toContain("focus=true");
  });

  test("the root tab resumes with --continue when it has a transcript", () => {
    expect(layoutKdl(["a"], self, { resume: new Set(["@root"]) })).toContain('args "claude" "@root" "--continue"');
  });

  test("every tab has sidebar, top panel, and agent in the workspace dir", () => {
    const kdl = layoutKdl(["a", "b"], self);
    for (const ws of ["a", "b"]) {
      expect(kdl).toContain(`args "sidebar" "--ws" "${ws}"`);
      expect(kdl).toContain(`args "top" "--ws" "${ws}"`);
      expect(kdl).toContain(`args "claude" "${ws}"`);
    }
    expect(kdl).toContain(`size=${SIDEBAR_WIDTH}`);
    expect(kdl).toContain(`size=${TOP_ROWS}`);
  });

  test("neither the tab bar nor the status bar plugin is loaded", () => {
    const kdl = layoutKdl(["a"], self);
    expect(kdl).not.toContain("tab-bar");
    expect(kdl).not.toContain("status-bar");
    expect(kdl).not.toContain("default_tab_template");
  });

  test("the sidebar takes focus in its tab", () => {
    expect(layoutKdl(["a"], self)).toMatch(/name="sidebar"[^\n]*focus=true/);
  });

  test("only workspaces with a transcript start the agent with --continue", () => {
    const kdl = layoutKdl(["a", "b"], self, { resume: new Set(["b"]) });
    expect(kdl).toContain('args "claude" "a"\n');
    expect(kdl).toContain('args "claude" "b" "--continue"');
  });

  test("sidebar width is configurable", () => {
    expect(layoutKdl(["a"], self, { sidebarWidth: 40 })).toContain("size=40");
  });

  test("is idempotent", () => {
    expect(layoutKdl(["a", "b"], self)).toBe(layoutKdl(["a", "b"], self));
  });
});

describe("transcripts", () => {
  test("resumable sees a .jsonl transcript for the workspace dir", () => {
    const home = join(tmp, "home");
    mkdirSync(transcriptDir(wsDir("a"), home), { recursive: true });
    writeFileSync(join(transcriptDir(wsDir("a"), home), "s.jsonl"), "{}\n");
    mkdirSync(transcriptDir(wsDir("b"), home), { recursive: true });
    expect([...resumable(["a", "b", "c"], home)]).toEqual(["a"]);
  });

  test("resumable sees a transcript for the root as the root orchestration tab", () => {
    const home = join(tmp, "home");
    mkdirSync(transcriptDir(root(), home), { recursive: true });
    writeFileSync(join(transcriptDir(root(), home), "s.jsonl"), "{}\n");
    expect([...resumable(["a"], home)]).toEqual(["@root"]);
  });
});

describe("user layout", () => {
  test("config dir: ZELLIJ_CONFIG_DIR, then XDG_CONFIG_HOME, then ~/.config", () => {
    expect(zellijConfigDir({ ZELLIJ_CONFIG_DIR: "/z" }, "/h")).toBe("/z");
    expect(zellijConfigDir({ XDG_CONFIG_HOME: "/x" }, "/h")).toBe("/x/zellij");
    expect(zellijConfigDir({}, "/h")).toBe("/h/.config/zellij");
  });

  test("a user file wins over the generated layout", () => {
    const path = join(tmp, "layouts", "overbridge.kdl");
    expect(chooseLayout(["a"], self, path).source).toBe("generated");
    mkdirSync(join(tmp, "layouts"));
    writeFileSync(path, "layout {}\n");
    expect(chooseLayout(["a"], self, path)).toEqual({ source: "user", path });
  });

  test("the user path is layouts/overbridge.kdl in the config dir", () => {
    expect(userLayoutPath("/z")).toBe("/z/layouts/overbridge.kdl");
  });
});

describe("newTabKdl", () => {
  test("holds exactly one tab, focused, with the same panes as the full layout", () => {
    const kdl = newTabKdl("gh-app-12", self, { focus: true });
    expect(tabs(kdl)).toBe(1);
    expect(kdl).toContain('tab name="gh-app-12" focus=true');
    expect(kdl).toContain('"sidebar" "--ws" "gh-app-12"');
    expect(kdl).not.toContain("status-bar");
  });

  test("a prompt reaches the agent after `--`; resuming wins over it", () => {
    expect(newTabKdl("ENG-1", self, { prompt: "/start-item ENG-1" })).toContain('args "claude" "ENG-1" "--" "/start-item ENG-1"');
    const resumed = newTabKdl("ENG-1", self, { prompt: "/start-item ENG-1", resume: true });
    expect(resumed).toContain('"--continue"');
    expect(resumed).not.toContain("/start-item");
  });
});
