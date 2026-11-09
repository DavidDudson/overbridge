import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type ButtonSpec } from "../src/project-config";
import { withState } from "../src/state";
import {
  type ActDeps,
  activate,
  buttonEnv,
  buttons,
  buttonUrl,
  type CustomButton,
  parseButtonStatus,
  refreshTop,
  snapshotTop,
  type TopSnapshot,
} from "../src/top";
import { fakeProvider } from "./helpers/fake-provider";

const spec = (over: Partial<ButtonSpec> = {}): ButtonSpec => ({ id: "b", label: "🎨 Chromatic", side: "right", url: "https://c/{branch}", ...over });
const custom = (over: Partial<CustomButton> = {}): CustomButton => ({
  repo: "app",
  spec: spec(),
  dir: "/w/w1/app",
  env: buttonEnv("w1", "app", { branch: "feat/x y", pr: 7 }),
  ...over,
});
const snap = (customs: CustomButton[]): TopSnapshot => ({ ws: "w1", dir: "/w/w1", links: [], apps: [], custom: customs });

describe("config", () => {
  const err = (yaml: string) => {
    try {
      parseConfig(yaml, "f.yml");
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };

  test("a repo's own overbridge.yml can't declare buttons", () => {
    expect(err("buttons:\n  - { id: a, label: A, run: x }\n")).toContain("buttons: only allowed in the root config.yml");
  });
});

describe("parseButtonStatus", () => {
  test("reads JSON text and colour, or the first line as text", () => {
    expect(parseButtonStatus('{"text":"3 changes","color":"yellow"}\n')).toEqual({ text: "3 changes", color: "yellow" });
    expect(parseButtonStatus('{"color":"mauve","text":""}')).toEqual({});
    expect(parseButtonStatus("passed\nmore detail")).toEqual({ text: "passed" });
    expect(parseButtonStatus("{not json")).toEqual({ text: "{not json" });
    expect(parseButtonStatus("  \n")).toEqual({});
  });
});

describe("buttonUrl", () => {
  test("fills and encodes the placeholders", () => {
    expect(buttonUrl("https://c/{repo}/{branch}?pr={pr}&ws={ws}", custom().env)).toBe("https://c/app/feat%2Fx%20y?pr=7&ws=w1");
  });
});

describe("buttons", () => {
  test("go to their side, with the status text and colour, and no key", () => {
    const out = buttons(snap([custom({ state: { text: "2 changes", color: "yellow" } }), custom({ spec: spec({ id: "c", label: "Docs", side: "left" }) })]));
    const mine = out.filter((b) => b.action.kind === "custom");
    expect(mine.map((b) => [b.label, b.side, b.color, b.key])).toEqual([
      ["🎨 Chromatic: 2 changes", "right", "yellow", undefined],
      ["Docs", "left", undefined, undefined],
    ]);
  });

  test("name their repo when the workspace has more than one", () => {
    const out = buttons(snap([custom(), custom({ repo: "infra" })]));
    expect(out.filter((b) => b.action.kind === "custom").map((b) => b.label)).toEqual(["app 🎨 Chromatic", "infra 🎨 Chromatic"]);
  });

  test("pressing one opens its URL or runs its command in the worktree", () => {
    const calls: string[] = [];
    const deps = {
      open: (u: string) => void calls.push(`open ${u}`),
      run: (cmd: string, dir: string, env: Record<string, string>) => void calls.push(`run ${cmd} in ${dir} branch=${env.OVERBRIDGE_BRANCH}`),
    } as unknown as ActDeps;
    activate({ label: "u", action: { kind: "custom", button: custom() } }, deps);
    activate({ label: "r", action: { kind: "custom", button: custom({ spec: spec({ url: undefined, run: "make docs" }) }) } }, deps);
    activate({ label: "s", action: { kind: "custom", button: custom({ spec: spec({ url: undefined, status: "x" }) }) } }, deps);
    expect(calls).toEqual(["open https://c/feat%2Fx%20y", "run make docs in /w/w1/app branch=feat/x y"]);
  });
});

describe("refresh and snapshot", () => {
  let tmp: string;
  const savedRoot = process.env.OVERBRIDGE_ROOT;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-buttons-")));
    process.env.OVERBRIDGE_ROOT = tmp;
    mkdirSync(join(tmp, "w1", "app"), { recursive: true });
    writeFileSync(
      join(tmp, "config.yml"),
      [
        "defaults:",
        "  buttons:",
        "    - { id: checks, label: Checks, status: 'my-status', url: 'https://c/{pr}' }",
        "    - { id: quiet, label: Quiet, status: 'print-nothing', run: x }",
        "    - { id: docs, label: Docs, run: 'make docs' }",
      ].join("\n"),
    );
    withState((s) => {
      s.workspaces.w1 = { created: "now", repos: { app: { branch: "feat/12-x", pr: 3 } } };
    });
  });

  afterEach(() => {
    savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
    rmSync(tmp, { recursive: true, force: true });
  });

  test("refresh runs each status command with the claim's env and caches what it printed", async () => {
    const ran: string[][] = [];
    const exec = (cmd: string[]) => {
      if (cmd[0] !== "env") return undefined;
      ran.push(cmd);
      return cmd.at(-1) === "my-status" ? '{"text":"green","color":"green"}' : undefined;
    };
    const cache = refreshTop("w1", { provider: () => fakeProvider(), exec });
    expect(cache.buttons).toEqual({ "app/checks": { text: "green", color: "green" } });
    expect(ran[0]).toEqual(["env", "OVERBRIDGE_NAME=w1", "OVERBRIDGE_REPO=app", "OVERBRIDGE_BRANCH=feat/12-x", "OVERBRIDGE_PR=3", "sh", "-c", "my-status"]);
    const shown = (await snapshotTop("w1", {})).custom?.map((c) => [c.spec.id, c.state?.text]);
    // `quiet` printed nothing, so it stays hidden; `docs` has no status, so it always shows
    expect(shown).toEqual([
      ["checks", "green"],
      ["docs", undefined],
    ]);
  });
});
