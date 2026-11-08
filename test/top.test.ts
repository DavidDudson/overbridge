import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppStatus } from "../src/apps";
import type { AppSpec } from "../src/project-config";
import { withState } from "../src/state";
import { type ActDeps, activate, buttons, hit, layoutTop, openTarget, readTopCache, refreshTop, snapshotTop, type TopApp, type TopSnapshot } from "../src/top";
import { fakeProvider } from "./helpers/fake-provider";

const spec = (id: string): AppSpec => ({ id, label: id, dir: ".", start: "x", ports: [], open: false, when: "always" });
const app = (id: string, status: AppStatus, port?: number, available = true): TopApp => ({
  repo: "r",
  spec: { ...spec(id), ready: { kind: "http", url: "http://localhost:{port}" } },
  repoDir: "/w/r",
  status,
  available,
  ...(port === undefined ? {} : { port }),
});
const snap = (over: Partial<TopSnapshot> = {}): TopSnapshot => ({ ws: "w1", dir: "/w/w1", links: [], apps: [], ...over });

describe("buttons and layout", () => {
  test("orders links, editor, then apps with state marks and ports", () => {
    const s = snap({
      links: [{ label: "PR #3", url: "u3" }],
      ide: "zed",
      apps: [app("web", AppStatus.Running, 3000), app("db", AppStatus.Stopped), app("api", AppStatus.Starting, 3001), app("job", AppStatus.Exited, 3002)],
    });
    expect(buttons(s).map((b) => b.label)).toEqual(["PR #3", "zed", "● web :3000", "○ db", "◐ api :3001", "✖ job :3002"]);
  });

  test("leaves out apps ruled out by `when`", () => {
    expect(buttons(snap({ apps: [app("web", AppStatus.Stopped, undefined, false)] }))).toEqual([]);
  });

  test("headline, button row, message row", () => {
    const f = layoutTop(snap({ headline: "12 Add dark mode", links: [{ label: "PR #3", url: "u" }], message: "oops" }), 60);
    expect(f.rows).toEqual(["12 Add dark mode", "[ PR #3 ]", "oops"]);
  });

  test("falls back to the workspace name without a headline", () => {
    expect(layoutTop(snap(), 40).rows[0]).toBe("w1");
  });

  test("wraps buttons between headline and message and never exceeds the width", () => {
    const links = ["alpha", "bravo", "charlie", "delta"].map((label) => ({ label, url: label }));
    const f = layoutTop(snap({ links, message: "m" }), 24);
    expect(f.rows.length).toBeGreaterThan(3);
    expect(f.rows[0]).toBe("w1");
    expect(f.rows.at(-1)).toBe("m");
    for (const row of f.rows) expect(row.length).toBeLessThanOrEqual(24);
    expect(f.placed.map((p) => p.button.label)).toEqual(["alpha", "bravo", "charlie", "delta"]);
    for (const p of f.placed) expect(f.rows[p.row]!.slice(p.col, p.col + p.width)).toBe(`[ ${p.button.label} ]`);
  });

  test("clips an over-long headline", () => {
    const f = layoutTop(snap({ headline: "x".repeat(50) }), 10);
    expect(f.rows[0]).toHaveLength(10);
    expect(f.rows[0]!.endsWith("…")).toBe(true);
  });

  test("hit finds the button under a cell", () => {
    const f = layoutTop(snap({ links: [{ label: "a", url: "ua" }, { label: "b", url: "ub" }] }), 40);
    const [a, b] = f.placed;
    expect(hit(f, a!.col, a!.row)).toBe(0);
    expect(hit(f, b!.col + b!.width - 1, b!.row)).toBe(1);
    expect(hit(f, b!.col + b!.width, b!.row)).toBeUndefined();
    expect(hit(f, 0, 0)).toBeUndefined();
  });
});

describe("activate", () => {
  const calls: string[] = [];
  const deps: ActDeps = {
    open: (u) => calls.push(`open ${u}`),
    spawn: (c) => calls.push(`spawn ${c.join(" ")}`),
    start: (a) => calls.push(`start ${a.spec.id}`),
    stop: (a) => calls.push(`stop ${a.spec.id}`),
  };
  beforeEach(() => void (calls.length = 0));

  test("link opens the url", () => {
    activate({ label: "l", action: { kind: "link", url: "u" } }, deps);
    expect(calls).toEqual(["open u"]);
  });

  test("editor launches the ide on the workspace folder", () => {
    activate({ label: "z", action: { kind: "editor", cmd: ["code"], dir: "/w/w1" } }, deps);
    expect(calls).toEqual(["spawn code /w/w1"]);
  });

  test("with no ide configured, the editor button falls back to $EDITOR", () => {
    const [b] = buttons(snap({ editor: "/usr/bin/code -w" }));
    expect(b!.label).toBe("code");
    activate(b!, deps);
    expect(calls).toEqual(["spawn /usr/bin/code -w /w/w1"]);
  });

  test("an ide name in the env maps to its command", () => {
    const [b] = buttons(snap({ editor: "webstorm" }));
    expect(b!.action).toEqual({ kind: "editor", cmd: ["webstorm"], dir: "/w/w1" });
  });

  test("a configured ide wins over $EDITOR; neither means no editor button", () => {
    expect(buttons(snap({ ide: "zed", editor: "vim" })).map((b) => b.label)).toEqual(["zed"]);
    expect(buttons(snap({ editor: "  " }))).toEqual([]);
  });

  test("an app toggles: stopped/exited start, starting/running stop", () => {
    for (const status of [AppStatus.Stopped, AppStatus.Exited]) activate({ label: "a", action: { kind: "app", app: app("web", status) } }, deps);
    for (const status of [AppStatus.Starting, AppStatus.Running]) activate({ label: "a", action: { kind: "app", app: app("web", status) } }, deps);
    expect(calls).toEqual(["start web", "start web", "stop web", "stop web"]);
  });

  test("a failing start becomes the message", () => {
    const msg = activate({ label: "a", action: { kind: "app", app: app("web", AppStatus.Stopped) } }, { ...deps, start: () => { throw new Error("no free port"); } });
    expect(msg).toBe("no free port");
  });

  test("openTarget is the url of a running app only", () => {
    expect(openTarget({ label: "a", action: { kind: "app", app: app("web", AppStatus.Running, 3000) } })).toBe("http://localhost:3000");
    expect(openTarget({ label: "a", action: { kind: "app", app: app("web", AppStatus.Starting, 3000) } })).toBeUndefined();
    expect(openTarget({ label: "l", action: { kind: "link", url: "u" } })).toBeUndefined();
  });
});

describe("refreshTop", () => {
  let tmp: string;
  const savedRoot = process.env.OVERBRIDGE_ROOT;
  const items = [{ id: "12", title: "Add dark mode", url: "x" }];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "overbridge-top-"));
    process.env.OVERBRIDGE_ROOT = tmp;
    mkdirSync(join(tmp, "w1", "r"), { recursive: true });
    writeFileSync(join(tmp, "w1", "r", "overbridge.yml"), "version: 1\nproject-management:\n  name: github\n  project: o/r\n");
    withState((s) => {
      s.workspaces.w1 = { created: "now", repos: { r: { branch: "feat/12-dark-mode", pr: 3 } } };
    });
  });

  afterEach(() => {
    savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("caches the headline, the item link and the PR link", () => {
    const cache = refreshTop("w1", { provider: () => fakeProvider(items), exec: () => "https://host/o/r/pull/3" });
    expect(cache.headline).toBe("12 Add dark mode");
    expect(cache.links).toEqual([
      { label: "12", url: "https://fake.test/items/12" },
      { label: "PR #3", url: "https://host/o/r/pull/3" },
    ]);
    expect(readTopCache("w1")).toEqual(cache);
  });

  test("snapshotTop prefers $OVERBRIDGE_IDE over $EDITOR, and a configured ide over both", async () => {
    expect((await snapshotTop("w1", { OVERBRIDGE_IDE: "zed", EDITOR: "vim" })).editor).toBe("zed");
    expect((await snapshotTop("w1", { EDITOR: "vim" })).editor).toBe("vim");
    expect((await snapshotTop("w1", { OVERBRIDGE_IDE: " ", EDITOR: "vim" })).editor).toBe("vim");
    expect((await snapshotTop("w1", {})).editor).toBeUndefined();
    writeFileSync(join(tmp, "w1", "r", "overbridge.yml"), "version: 1\nide: vscode\n");
    const s = await snapshotTop("w1", { OVERBRIDGE_IDE: "zed" });
    expect(s.ide).toBe("vscode");
    expect(s.editor).toBeUndefined();
  });

  test("a failed lookup keeps the old values and reports a message", () => {
    refreshTop("w1", { provider: () => fakeProvider(items), exec: () => "https://host/o/r/pull/3" });
    const cache = refreshTop("w1", { provider: () => { throw new Error("offline"); }, exec: () => undefined });
    expect(cache.headline).toBe("12 Add dark mode");
    expect(cache.links).toHaveLength(2);
    expect(cache.message).toContain("offline");
    expect(cache.message).toContain("no URL for PR #3");
  });
});
