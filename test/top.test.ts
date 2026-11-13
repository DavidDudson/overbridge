import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppStatus } from "../src/apps";
import type { AppSpec } from "../src/project-config";
import { withState } from "../src/state";
import { type ActDeps, activate, applyOptimistic, buttons, CLEANUP_ARM_MS, cell, classifyPr, cleanable, claimedCache, hit, layoutTop, openTarget, pressCleanup, readTopCache, refreshTop, snapshotTop, type PrInfo, type TopApp, type TopLink, type TopSnapshot } from "../src/top";
import { textWidth } from "../src/term";
import { fakeProvider } from "./helpers/fake-provider";

const prJson = (state = "OPEN", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ url: "https://host/o/r/pull/3", state, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [], ...extra });
const noPane = () => undefined;
const editorButton = (s: TopSnapshot) => buttons(s).find((b) => b.action.kind === "editor");

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
  test("links at the left; apps, editor and pane toggles at the right, with state marks and ports", () => {
    const s = snap({
      links: [{ label: "PR #3", url: "u3" }],
      ide: "zed",
      apps: [app("web", AppStatus.Running, 3000), app("db", AppStatus.Stopped), app("api", AppStatus.Starting, 3001), app("job", AppStatus.Exited, 3002)],
    });
    expect(buttons(s).map((b) => b.label)).toEqual(["📋 PR #3", "🟢 web :3000", "⚫ db", "🟡 api :3001", "🔴 job :3002", "📝 zed", "🤖 claude", "💻 terminal", "🔀 diff"]);
    expect(buttons(s).filter((b) => b.side === "left")).toHaveLength(1);
    expect(buttons(s).find((b) => b.label.includes("web"))!.color).toBe("green");
    expect(buttons(s).find((b) => b.label.includes("job"))!.color).toBe("red");
  });

  test("leaves out apps ruled out by `when`", () => {
    expect(buttons(snap({ apps: [app("web", AppStatus.Stopped, undefined, false)] })).filter((b) => b.action.kind === "app")).toEqual([]);
  });

  test("task-name title, one button row with links left and launchers right, message in the bottom border", () => {
    const f = layoutTop(snap({ title: "Add dark mode", links: [{ label: "PR #3", url: "u" }], message: "oops" }), 80);
    expect(f.rows).toHaveLength(3);
    expect(f.rows[0]).toMatch(/^╭─ Add dark mode ─+╮$/);
    expect(f.rows[2]).toMatch(/^╰─ oops ─+╯$/);
    expect(new Set(f.placed.map((p) => p.row))).toEqual(new Set([1]));
    expect(f.placed[0]!.col).toBe(2);
    const last = f.placed.at(-1)!;
    expect(last.col + last.width).toBe(78);
    expect(f.placed.map((p) => p.button.label)).toEqual(["📋 PR #3", "🤖 claude", "💻 terminal", "🔀 diff"]);
  });

  test("falls back to the workspace name without a title", () => {
    expect(layoutTop(snap(), 40).rows[0]).toMatch(/^╭─ w1 ─+╮$/);
  });

  test("wraps buttons inside the frame and never exceeds the width", () => {
    const links = ["alpha", "bravo", "charlie", "delta"].map((label) => ({ label, url: label }));
    const f = layoutTop(snap({ links, message: "m" }), 24);
    expect(f.rows.length).toBeGreaterThan(3);
    expect(f.rows[0]).toMatch(/^╭─ w1 ─+╮$/);
    expect(f.rows.at(-1)).toMatch(/^╰─ m ─+╯$/);
    for (const row of f.rows) expect(textWidth(row)).toBeLessThanOrEqual(24);
    for (const p of f.placed) expect(p.col + p.width).toBeLessThanOrEqual(22);
    expect(f.placed.map((p) => p.button.label).slice(0, 4)).toEqual(["📋 alpha", "📋 bravo", "📋 charlie", "📋 delta"]);
  });

  test("clips an over-long title inside the border", () => {
    const f = layoutTop(snap({ title: "x".repeat(50) }), 20);
    expect(textWidth(f.rows[0]!)).toBe(20);
    expect(f.rows[0]).toContain("…");
    expect(f.rows[0]!.endsWith("╮")).toBe(true);
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

describe("PR rows", () => {
  const info = (over: Partial<PrInfo> = {}): PrInfo => ({ repo: "api", number: 7, title: "feat: add x", draft: false, dir: "/w/w1/api", stack: [], ...over });
  const withPr = (status: TopLink["status"], pr: PrInfo) => snap({ links: [{ label: "PR #7", url: "u7", status, pr }] });

  test("a PR is named by repo, number and title, with draft and merge actions at its right", () => {
    const b = buttons(withPr("mergeable", info()));
    expect(b.filter((x) => x.prRow === 0).map((x) => x.label)).toEqual(["🟢 api #7 feat: add x", "📝 Draft", "🟣 Merge"]);
    expect(b.find((x) => x.label === "📝 Draft")!.key).toBe("g");
    expect(b.find((x) => x.label === "🟣 Merge")!.key).toBe("m");
  });

  test("the reviewers sit between the PR and its actions", () => {
    const reviewers = [{ name: "Copilot" as const, state: "none" as const }, { name: "CodeRabbit" as const, state: "limited" as const, detail: "56m" }];
    const b = buttons(withPr("mergeable", info({ reviewers })));
    expect(b.filter((x) => x.prRow === 0).map((x) => x.label)).toEqual(["🟢 api #7 feat: add x", "⚪ Copilot", "🚫 CodeRabbit 56m", "📝 Draft", "🟣 Merge"]);
  });

  test("a draft offers Ready and no Merge; merge needs a green PR", () => {
    expect(buttons(withPr("mergeable", info({ draft: true }))).filter((x) => x.prRow === 0).map((x) => x.label)).toEqual(["🟢 api #7 feat: add x", "✅ Ready"]);
    expect(buttons(withPr("failing", info())).map((x) => x.label)).not.toContain("🟣 Merge");
    expect(buttons(withPr("pending", info())).map((x) => x.label)).not.toContain("🟣 Merge");
  });

  test("a three-layer stack lists every PR bottom to top, numbered; actions only on the claimed layer", () => {
    const stack = [11, 12, 13];
    const layer = (n: number) => ({ number: n, stack, layer: { n: stack.indexOf(n) + 1, of: 3 }, claimed: n === 12 });
    const links = stack.map((n) => ({ label: `PR #${n}`, url: `u${n}`, status: "mergeable" as const, pr: info(layer(n)) }));
    const b = buttons(snap({ links }));
    expect(b.filter((x) => x.action.kind === "link").map((x) => x.label)).toEqual(["🟢 api #11 1/3 feat: add x", "🟢 api #12 2/3 feat: add x", "🟢 api #13 3/3 feat: add x"]);
    expect(b.filter((x) => x.prRow === 0 || x.prRow === 2).map((x) => x.label)).toEqual(["🟢 api #11 1/3 feat: add x", "🟢 api #13 3/3 feat: add x"]);
    expect(b.filter((x) => x.prRow === 1).map((x) => x.label)).toEqual(["🟢 api #12 2/3 feat: add x", "📝 Draft", "🟣 Merge stack"]);
  });

  test("merged and closed PRs have no actions; a stack merges as a stack", () => {
    expect(buttons(withPr("merged", info())).filter((x) => x.prRow === 0)).toHaveLength(1);
    expect(buttons(withPr("closed", info())).filter((x) => x.prRow === 0)).toHaveLength(1);
    expect(buttons(withPr("mergeable", info({ stack: [6, 7] }))).map((x) => x.label)).toContain("🟣 Merge stack");
  });

  test("each PR gets its own row, actions right-aligned, the launchers in their own section below", () => {
    const s = snap({ links: [{ label: "a #1", url: "u1", status: "mergeable", pr: info({ number: 1 }) }, { label: "b #2", url: "u2", status: "failing", pr: info({ repo: "web", number: 2 }) }], ide: "zed" });
    const f = layoutTop(s, 100);
    const rowOf = (label: string) => f.placed.find((p) => p.button.label.includes(label))!;
    expect(rowOf("api #1").row).toBe(1);
    expect(rowOf("web #2").row).toBe(2);
    expect(f.rules).toEqual([{ row: 3, text: expect.stringContaining("actions") }]);
    expect(rowOf("zed").row).toBe(4);
    const merge = rowOf("Merge");
    expect(merge.row).toBe(1);
    expect(merge.col + merge.width).toBe(98);
    expect(f.placed.filter((p) => p.row === 2).map((p) => p.button.label)).toEqual(["🔴 web #2 feat: add x", "📝 Draft"]);
  });

  test("a long PR name is clipped to leave room for its actions", () => {
    const f = layoutTop(withPr("mergeable", info({ title: "x".repeat(100) })), 70);
    const [main, ...actions] = f.placed.filter((p) => p.row === 1);
    expect(main!.col + main!.width).toBeLessThan(actions[0]!.col);
    expect(actions).toHaveLength(2);
  });

  test("activating the actions calls the deps with the PR", () => {
    const calls: string[] = [];
    const deps: ActDeps = { open: () => {}, spawn: () => {}, start: () => {}, stop: () => {}, pane: noPane, cleanup: () => undefined, ready: (p, r) => void calls.push(`ready ${p.number} ${r}`), merge: (p) => void calls.push(`merge ${p.number}`), run: () => {} };
    activate({ label: "r", action: { kind: "ready", pr: info({ draft: true }) } }, deps);
    activate({ label: "d", action: { kind: "ready", pr: info() } }, deps);
    activate({ label: "m", action: { kind: "merge", pr: info() } }, deps);
    expect(calls).toEqual(["ready 7 true", "ready 7 false", "merge 7"]);
  });
});

describe("activate", () => {
  const calls: string[] = [];
  const deps: ActDeps = {
    open: (u) => calls.push(`open ${u}`),
    spawn: (c) => calls.push(`spawn ${c.join(" ")}`),
    start: (a) => calls.push(`start ${a.spec.id}`),
    stop: (a) => calls.push(`stop ${a.spec.id}`),
    pane: (p) => void calls.push(`pane ${p}`),
    cleanup: () => void calls.push("cleanup"),
    ready: (p, r) => void calls.push(`ready ${p.number} ${r}`),
    merge: (p) => void calls.push(`merge ${p.number}`),
    run: (cmd, dir, env) => void calls.push(`run ${cmd} in ${dir} pr=${env.OVERBRIDGE_PR}`),
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
    const b = editorButton(snap({ editor: "/usr/bin/code -w" }));
    expect(b!.label).toBe("📝 code");
    activate(b!, deps);
    expect(calls).toEqual(["spawn /usr/bin/code -w /w/w1"]);
  });

  test("an ide name in the env maps to its command", () => {
    const b = editorButton(snap({ editor: "webstorm" }));
    expect(b!.action).toEqual({ kind: "editor", cmd: ["webstorm"], dir: "/w/w1" });
  });

  test("a configured ide wins over $EDITOR; neither means no editor button", () => {
    expect(editorButton(snap({ ide: "zed", editor: "vim" }))!.label).toBe("📝 zed");
    expect(editorButton(snap({ editor: "  " }))).toBeUndefined();
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
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-top-")));
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

  test("records whether every claimed PR is an open draft, and when the PRs last changed", () => {
    const draft = refreshTop("w1", { provider: () => fakeProvider(items), exec: () => prJson("OPEN", { isDraft: true, updatedAt: "2026-06-01T00:00:00Z" }) });
    expect(draft.draftOnly).toBe(true);
    expect(draft.prActiveAt).toBe(Date.parse("2026-06-01T00:00:00Z"));
    const ready = refreshTop("w1", { provider: () => fakeProvider(items), exec: () => prJson("OPEN", { isDraft: false }) });
    expect(ready.draftOnly).toBeUndefined();
    expect(refreshTop("w1", { provider: () => fakeProvider(items), exec: () => prJson("MERGED", { isDraft: true }) }).draftOnly).toBeUndefined();
  });

  test("while gh is paused by a rate limit, no gh call is made, the old values stay and the message row says why", () => {
    const first = refreshTop("w1", { provider: () => fakeProvider(items), exec: () => prJson("OPEN", {}) });
    const notice = "GitHub rate limit reached: gh calls paused until 14:32:10, showing cached data";
    let calls = 0;
    const paused = refreshTop("w1", { provider: () => (calls++, fakeProvider(items)), exec: () => (calls++, undefined), paused: notice });
    expect(calls).toBe(0);
    expect(paused.message).toBe(notice);
    expect(paused.links).toEqual(first.links);
    expect(refreshTop("w1", { provider: () => fakeProvider(items), exec: () => prJson("OPEN", {}) }).message).toBeUndefined();
  });

  test("caches the headline, the item link and the PR link", () => {
    const cache = refreshTop("w1", { provider: () => fakeProvider(items), exec: () => prJson("OPEN", { title: "" }) });
    expect(cache.headline).toBe("12 Add dark mode");
    expect(cache.links).toEqual([
      { label: "12", url: "https://fake.test/items/12" },
      { label: "PR #3", url: "https://host/o/r/pull/3", status: "mergeable", pr: { repo: "r", number: 3, title: "", draft: false, dir: join(tmp, "w1", "r"), stack: [], reviewers: [{ name: "Copilot", state: "none", url: "https://host/o/r/pull/3" }] } },
    ]);
    expect(readTopCache("w1")).toEqual(cache);
  });

  test("a stacked claim caches every layer, bottom first, and counts only the claimed PR", () => {
    const layer = (branch: string, pr: number) => ({ branch, pullRequest: { number: pr } });
    mkdirSync(join(tmp, ".bare", "r.git"), { recursive: true });
    writeFileSync(
      join(tmp, ".bare", "r.git", "gh-stack"),
      JSON.stringify({ schemaVersion: 1, stacks: [{ trunk: { branch: "main" }, branches: [layer("feat/11-a", 2), layer("feat/12-dark-mode", 3), layer("feat/13-c", 4)] }] }),
    );
    const viewed: string[] = [];
    const exec = (cmd: string[]) => {
      if (cmd[1] !== "pr") return undefined;
      viewed.push(cmd[3]!);
      return JSON.stringify({ url: `https://host/o/r/pull/${cmd[3]}`, title: `t${cmd[3]}`, state: cmd[3] === "3" ? "OPEN" : "MERGED", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", statusCheckRollup: [] });
    };
    const cache = refreshTop("w1", { provider: () => fakeProvider(items), exec });
    const prs = cache.links.flatMap((l) => (l.pr ? [l.pr] : []));
    expect(prs.map((p) => p.number)).toEqual([2, 3, 4]);
    expect(prs.map((p) => p.layer)).toEqual([{ n: 1, of: 3 }, { n: 2, of: 3 }, { n: 3, of: 3 }]);
    expect(prs.map((p) => p.claimed)).toEqual([false, true, false]);
    expect(prs.every((p) => p.stack.join() === "2,3,4")).toBe(true);
    expect(cache.prsOpen).toBe(true);
    expect(cache.merged).toBeUndefined();
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
    refreshTop("w1", { provider: () => fakeProvider(items), exec: () => prJson() });
    const cache = refreshTop("w1", { provider: () => { throw new Error("offline"); }, exec: () => undefined });
    expect(cache.headline).toBe("12 Add dark mode");
    expect(cache.links).toHaveLength(2);
    expect(cache.message).toContain("offline");
    expect(cache.message).toContain("no URL for PR #3");
  });
});

describe("cleanup", () => {
  test("Cleanup follows the links at the left, and only when the workspace can be wiped", () => {
    const base = snap({ links: [{ label: "PR #3", url: "u3" }], ide: "zed", apps: [app("web", AppStatus.Stopped)] });
    expect(buttons(base).map((b) => b.label)).not.toContain("🧹 Cleanup");
    expect(buttons({ ...base, cleanup: true }).filter((b) => b.side === "left").map((b) => b.label)).toEqual(["📋 PR #3", "🧹 Cleanup"]);
  });

  test("activating Cleanup calls the cleanup dep and shows its message", () => {
    const deps: ActDeps = { open: () => {}, spawn: () => {}, start: () => {}, stop: () => {}, pane: noPane, cleanup: () => "armed", ready: () => undefined, merge: () => undefined, run: () => {} };
    expect(activate({ label: "Cleanup", action: { kind: "cleanup" } }, deps)).toBe("armed");
  });

  test("the first press arms, a second within the window confirms, a late one re-arms", () => {
    const first = pressCleanup(undefined, 1_000);
    expect(first).toEqual({ confirmed: false, armedAt: 1_000 });
    expect(pressCleanup(first.armedAt, 1_000 + CLEANUP_ARM_MS)).toEqual({ confirmed: true, armedAt: undefined });
    expect(pressCleanup(first.armedAt, 1_000 + CLEANUP_ARM_MS + 1)).toEqual({ confirmed: false, armedAt: 1_000 + CLEANUP_ARM_MS + 1 });
  });
});

describe("cleanable", () => {
  let tmp: string;
  let wt: string;
  const savedRoot = process.env.OVERBRIDGE_ROOT;
  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };
  const sh = (cmd: string[], cwd: string) => {
    const p = Bun.spawnSync({ cmd, cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
    return p.stdout.toString().trim();
  };
  const items = [{ id: "12", title: "Add dark mode", url: "x" }];
  /** Cache the PR state as `gh` would report it. */
  const cachePr = (state: string, extra: Record<string, unknown> = {}) =>
    refreshTop("w1", { provider: () => fakeProvider(items), exec: () => prJson(state, extra) });
  const headSha = () => sh(["git", "rev-parse", "HEAD"], wt);

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-clean-")));
    process.env.OVERBRIDGE_ROOT = tmp;
    sh(["git", "init", "-q", "-b", "main", "src"], tmp);
    sh(["git", "commit", "-q", "--allow-empty", "-m", "init"], join(tmp, "src"));
    sh(["git", "clone", "-q", "--bare", "src", "remote.git"], tmp);
    mkdirSync(join(tmp, "w1"));
    sh(["git", "clone", "-q", join(tmp, "remote.git"), "r"], join(tmp, "w1"));
    wt = join(tmp, "w1", "r");
    sh(["git", "switch", "-q", "-c", "feat/12-dark-mode"], wt);
    sh(["git", "commit", "-q", "--allow-empty", "-m", "work"], wt);
    sh(["git", "push", "-q", "-u", "origin", "feat/12-dark-mode"], wt);
    withState((s) => {
      s.workspaces.w1 = { created: "now", repos: { r: { branch: "feat/12-dark-mode", pr: 3 } } };
    });
  });

  afterEach(() => {
    savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("an open PR with a clean, pushed tree is a candidate", () => {
    expect(cachePr("OPEN").prsOpen).toBe(true);
    expect(cleanable("w1")).toBe(true);
  });

  test("a merged, closed or missing PR is not", () => {
    expect(cachePr("MERGED").prsOpen).toBe(false);
    expect(cleanable("w1")).toBe(false);
    expect(refreshTop("w1", { provider: () => fakeProvider(items), exec: () => undefined }).prsOpen).toBe(false);
    expect(cleanable("w1")).toBe(false);
  });

  test("a claim whose PR merged does not block while another PR is open; a closed or PR-less claim still does", () => {
    withState((s) => {
      s.workspaces.w1!.repos.r2 = { branch: "feat/13-other", pr: 4 };
    });
    const open = (state3: string, state4: string) => refreshTop("w1", { provider: () => fakeProvider(items), exec: (cmd) => prJson(cmd[3] === "4" ? state4 : state3) }).prsOpen;
    expect(open("OPEN", "MERGED")).toBe(true);
    expect(open("MERGED", "OPEN")).toBe(true);
    expect(open("OPEN", "OPEN")).toBe(true);
    expect(open("MERGED", "MERGED")).toBe(false);
    expect(open("OPEN", "CLOSED")).toBe(false);
    withState((s) => {
      s.workspaces.w1!.repos.r2 = { branch: "feat/13-other" };
    });
    expect(open("OPEN", "OPEN")).toBe(false);
  });

  test("a claim that moved after the cache was built is not finished on the old PR's say", () => {
    expect(cachePr("MERGED", { headRefOid: headSha() }).merged).toBeDefined();
    expect(claimedCache("w1").merged).toBeDefined();
    withState((s) => {
      s.workspaces.w1!.repos.r = { branch: "feat/13-follow-up", reboundFrom: { branch: "feat/12-dark-mode", pr: 3 } };
    });
    expect(claimedCache("w1").merged).toBeUndefined();
    expect(claimedCache("w1").prsOpen).toBeUndefined();
    expect(cleanable("w1")).toBe(false);
    expect(cachePr("OPEN").branches).toEqual({ r: "feat/13-follow-up" });
  });

  test("a cache from before branches were recorded is trusted", () => {
    const old = cachePr("MERGED", { headRefOid: headSha() });
    const { branches: _b, ...legacy } = old;
    expect(claimedCache("w1", legacy as typeof old).merged).toBeDefined();
  });

  test("a just-cleared agent makes it a candidate even without an open PR, but dirty trees still block", () => {
    cachePr("MERGED");
    expect(cleanable("w1")).toBe(false);
    mkdirSync(join(tmp, ".overbridge", "agent"), { recursive: true });
    writeFileSync(join(tmp, ".overbridge", "agent", "w1.json"), JSON.stringify({ state: "empty", at: Date.now() }));
    expect(cleanable("w1")).toBe(true);
    writeFileSync(join(wt, "scratch.txt"), "x");
    expect(cleanable("w1")).toBe(false);
  });

  test("an orchestration tab is never a candidate, even with a just-cleared agent", () => {
    mkdirSync(join(tmp, ".overbridge", "agent"), { recursive: true });
    writeFileSync(join(tmp, ".overbridge", "agent", "@root.json"), JSON.stringify({ state: "empty", at: Date.now() }));
    expect(cleanable("@root")).toBe(false);
  });

  test("uncommitted changes block it", () => {
    cachePr("OPEN");
    writeFileSync(join(wt, "scratch.txt"), "x");
    expect(cleanable("w1")).toBe(false);
  });

  test("an unpushed commit blocks it", () => {
    cachePr("OPEN");
    sh(["git", "commit", "-q", "--allow-empty", "-m", "more"], wt);
    expect(cleanable("w1")).toBe(false);
  });

  test("a branch that was never pushed blocks it", () => {
    cachePr("OPEN");
    sh(["git", "switch", "-q", "-c", "feat/local-only"], wt);
    sh(["git", "commit", "-q", "--allow-empty", "-m", "local"], wt);
    expect(cleanable("w1")).toBe(false);
  });

  test("every PR merged at the local HEAD is a candidate, even once a squash merge deleted the remote branch", () => {
    const head = headSha();
    sh(["git", "push", "-q", "origin", "--delete", "feat/12-dark-mode"], wt);
    expect(cachePr("MERGED", { headRefOid: head }).merged).toEqual({ r: head });
    expect(cleanable("w1")).toBe(true);
  });

  test("a merged workspace with uncommitted changes, or a HEAD past the PR head, is not", () => {
    cachePr("MERGED", { headRefOid: headSha() });
    writeFileSync(join(wt, "scratch.txt"), "x");
    expect(cleanable("w1")).toBe(false);
    rmSync(join(wt, "scratch.txt"));
    expect(cleanable("w1")).toBe(true);
    sh(["git", "commit", "-q", "--allow-empty", "-m", "after merge"], wt);
    expect(cleanable("w1")).toBe(false);
  });

  test("merged is set only when every claimed branch has a merged PR with a head commit", () => {
    const head = headSha();
    expect(cachePr("MERGED").merged).toBeUndefined();
    expect(cachePr("CLOSED", { headRefOid: head }).merged).toBeUndefined();
    expect(cachePr("OPEN", { headRefOid: head }).merged).toBeUndefined();
    withState((s) => {
      s.workspaces.w1!.repos.r2 = { branch: "feat/13-other" };
    });
    expect(cachePr("MERGED", { headRefOid: head }).merged).toBeUndefined();
    withState((s) => {
      s.workspaces.w1!.repos.r2 = { branch: "feat/13-other", pr: 4 };
    });
    const states = (state4: string) => refreshTop("w1", { provider: () => fakeProvider(items), exec: (cmd) => prJson(cmd[3] === "4" ? state4 : "MERGED", { headRefOid: head }) }).merged;
    expect(states("CLOSED")).toBeUndefined();
    expect(states("MERGED")).toEqual({ r: head, r2: head });
  });

  test("snapshotTop offers Cleanup only for a candidate", async () => {
    cachePr("OPEN");
    expect((await snapshotTop("w1", {})).cleanup).toBe(true);
    writeFileSync(join(wt, "scratch.txt"), "x");
    expect((await snapshotTop("w1", {})).cleanup).toBeUndefined();
  });
});

describe("classifyPr", () => {
  const run = (conclusion: string, status = "COMPLETED") => ({ statusCheckRollup: [{ status, conclusion }] });
  test("merged and closed come first", () => {
    expect(classifyPr({ state: "MERGED", ...run("FAILURE") })).toBe("merged");
    expect(classifyPr({ state: "CLOSED" })).toBe("closed");
  });
  test("a failing check is failing, even with conflicts or others pending", () => {
    expect(classifyPr({ state: "OPEN", mergeable: "CONFLICTING", statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "IN_PROGRESS" }] })).toBe("failing");
    expect(classifyPr({ state: "OPEN", statusCheckRollup: [{ state: "ERROR" }] })).toBe("failing");
  });
  test("conflicts, then pending, then mergeability", () => {
    expect(classifyPr({ state: "OPEN", mergeable: "CONFLICTING" })).toBe("conflict");
    expect(classifyPr({ state: "OPEN", statusCheckRollup: [{ status: "IN_PROGRESS" }] })).toBe("pending");
    expect(classifyPr({ state: "OPEN", statusCheckRollup: [{ state: "PENDING" }] })).toBe("pending");
    expect(classifyPr({ state: "OPEN", mergeStateStatus: "CLEAN", ...run("SUCCESS") })).toBe("mergeable");
    expect(classifyPr({ state: "OPEN", mergeStateStatus: "BLOCKED", ...run("SUCCESS") })).toBe("blocked");
    expect(classifyPr({ state: "OPEN" })).toBe("unknown");
  });
  test("PR links are coloured by status", () => {
    const b = buttons(snap({ links: [{ label: "PR #3", url: "u", status: "merged" }] }))[0]!;
    expect(b).toMatchObject({ label: "🟣 PR #3", color: "purple" });
  });
});

describe("button keys", () => {
  test("issue i, PR p, apps 1-9, editor e, panes c t d, cleanup x, shown in the button", () => {
    const s = snap({
      links: [{ label: "12", url: "ui" }, { label: "PR #3", url: "up", status: "mergeable" }],
      ide: "zed",
      cleanup: true,
      apps: [app("web", AppStatus.Running, 3000), app("db", AppStatus.Stopped)],
    });
    const keys = Object.fromEntries(buttons(s).map((b) => [b.label, b.key]));
    expect(keys).toEqual({
      "📋 12": "i",
      "🟢 PR #3": "p",
      "🧹 Cleanup": "x",
      "🟢 web :3000": "1",
      "⚫ db": "2",
      "📝 zed": "e",
      "🤖 claude": "c",
      "💻 terminal": "t",
      "🔀 diff": "d",
    });
    expect(cell(buttons(s)[1]!)).toBe("[ 🟢 PR #3 · p ]");
  });

  test("several PRs get p, u, y...; no key clashes with the panel's own", () => {
    const links = ["a #1", "b #2", "c #3"].map((label) => ({ label, url: label, status: "pending" as const }));
    const keys = buttons(snap({ links })).map((b) => b.key).slice(0, 3);
    expect(keys).toEqual(["p", "u", "y"]);
    for (const k of ["q", "r", "o", "l", "h", "L"]) expect(buttons(snap({ links, ide: "zed", cleanup: true })).map((b) => b.key)).not.toContain(k);
  });
});

describe("optimistic PR changes", () => {
  const pr = (number: number, over: Partial<PrInfo> = {}): PrInfo => ({ repo: "api", number, title: "t", draft: false, dir: "/w/w1/api", stack: [], ...over });
  const link = (p: PrInfo, status: TopLink["status"] = "mergeable"): TopLink => ({ label: `PR #${p.number}`, url: `u${p.number}`, status, pr: p });

  test("Ready and Draft flip the draft flag at once, leaving other PRs alone", () => {
    const s = snap({ links: [link(pr(1, { draft: true }), "blocked"), link(pr(2))] });
    const ready = applyOptimistic(s, { kind: "ready", pr: pr(1, { draft: true }), ready: true });
    expect(ready.links.map((l) => l.pr!.draft)).toEqual([false, false]);
    const draft = applyOptimistic(s, { kind: "ready", pr: pr(2), ready: false });
    expect(draft.links.map((l) => l.pr!.draft)).toEqual([true, true]);
    expect(s.links.map((l) => l.pr!.draft)).toEqual([true, false]);
  });

  test("Merge marks the PR merged, so its actions disappear", () => {
    const s = snap({ links: [link(pr(1)), link(pr(2))] });
    const merged = applyOptimistic(s, { kind: "merge", pr: pr(1) });
    expect(merged.links.map((l) => l.status)).toEqual(["merged", "mergeable"]);
    expect(buttons(merged).filter((b) => b.prRow === 0)).toHaveLength(1);
  });

  test("a stack changes together, and only in its own repo", () => {
    const s = snap({ links: [link(pr(1, { stack: [1, 2] })), link(pr(2, { stack: [1, 2] })), link(pr(2, { repo: "web" }))] });
    const merged = applyOptimistic(s, { kind: "merge", pr: pr(1, { stack: [1, 2] }) });
    expect(merged.links.map((l) => l.status)).toEqual(["merged", "merged", "mergeable"]);
  });
});
