import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentStateFile } from "../src/agent-state";
import { iceboxHint, idleDaysFor, idleThreshold } from "../src/icebox-suggest";
import { entryLines, type Entry, Section } from "../src/sidebar";
import { withState } from "../src/state";

const DAY = 86_400_000;
const NOW = Date.parse("2026-06-30T00:00:00Z");

describe("idleDaysFor", () => {
  const base = { idleDays: 7, draftOnly: true, activityMs: [NOW - 10 * DAY], now: NOW };

  test("suggests once the last activity is at least the threshold old", () => {
    expect(idleDaysFor(base)).toBe(10);
    expect(idleDaysFor({ ...base, activityMs: [NOW - 7 * DAY] })).toBe(7);
    expect(idleDaysFor({ ...base, activityMs: [NOW - 7 * DAY + 1] })).toBeUndefined();
  });

  test("any recent activity (commit, PR update or agent) keeps it quiet", () => {
    expect(idleDaysFor({ ...base, activityMs: [NOW - 10 * DAY, NOW - DAY, undefined] })).toBeUndefined();
  });

  test("is off when the threshold is unset, a PR is not a draft, or nothing is known", () => {
    expect(idleDaysFor({ ...base, idleDays: undefined })).toBeUndefined();
    expect(idleDaysFor({ ...base, draftOnly: false })).toBeUndefined();
    expect(idleDaysFor({ ...base, draftOnly: undefined })).toBeUndefined();
    expect(idleDaysFor({ ...base, activityMs: [undefined] })).toBeUndefined();
  });
});

describe("iceboxHint", () => {
  let tmp: string;
  const savedRoot = process.env.OVERBRIDGE_ROOT;
  const wt = () => join(tmp, "w1", "r");
  const commitAt = (ms: number) => {
    const date = new Date(ms).toISOString();
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date, GIT_CONFIG_GLOBAL: "/dev/null" };
    for (const cmd of [["git", "init", "-q", "-b", "main", "."], ["git", "commit", "-q", "--allow-empty", "-m", "x"]]) {
      const p = Bun.spawnSync({ cmd, cwd: wt(), env });
      if (p.exitCode !== 0) throw new Error(p.stderr.toString());
    }
  };
  const config = (yml: string) => writeFileSync(join(wt(), "overbridge.yml"), `version: 1\n${yml}`);

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-suggest-")));
    process.env.OVERBRIDGE_ROOT = tmp;
    mkdirSync(wt(), { recursive: true });
    withState((s) => {
      s.workspaces.w1 = { created: "now", repos: { r: { branch: "feat/x", pr: 3 } } };
    });
    commitAt(NOW - 10 * DAY);
    config("icebox:\n  idle-days: 7\n");
  });

  afterEach(() => {
    savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("names the idle days for an idle draft workspace", () => {
    expect(iceboxHint("w1", { draftOnly: true }, NOW)).toBe("draft PRs idle 10d · icebox?");
  });

  test("says nothing unless every PR is a draft", () => {
    expect(iceboxHint("w1", {}, NOW)).toBeUndefined();
  });

  test("says nothing when the threshold is unset", () => {
    config("");
    expect(idleThreshold("w1")).toBeUndefined();
    expect(iceboxHint("w1", { draftOnly: true }, NOW)).toBeUndefined();
  });

  test("a recent PR update or agent record counts as activity", () => {
    expect(iceboxHint("w1", { draftOnly: true, prActiveAt: NOW - DAY }, NOW)).toBeUndefined();
    mkdirSync(join(tmp, ".overbridge", "agent"), { recursive: true });
    writeFileSync(agentStateFile("w1"), JSON.stringify({ state: "idle", at: NOW - 2 * DAY }));
    expect(iceboxHint("w1", { draftOnly: true }, NOW)).toBeUndefined();
  });

  test("takes the smallest threshold across a workspace's repos and skips a bad config", () => {
    config("icebox:\n  idle-days: 30\n");
    expect(idleThreshold("w1")).toBe(30);
    config("icebox: { idle-days: 0 }\n");
    expect(idleThreshold("w1")).toBeUndefined();
  });
});

describe("the card", () => {
  const card = (extra: Partial<Entry>): Entry => ({ tab: "w1", section: Section.Workspaces, glyph: "💤", label: "w1", state: "idle", ...extra });
  const text = (e: Entry) => entryLines(e, 0, false, 40).join("\n");

  test("shows the hint on an idle card", () => {
    expect(text(card({ idleHint: "draft PRs idle 10d · icebox?" }))).toContain("draft PRs idle 10d · icebox?");
  });

  test("a card that wants you shows that first", () => {
    expect(text(card({ state: "waiting", idleHint: "draft PRs idle 10d · icebox?" }))).toContain("needs your input");
  });
});
