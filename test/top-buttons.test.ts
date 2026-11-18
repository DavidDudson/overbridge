import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBuiltins } from "../src/pm";
import { parseConfig, type ButtonSpec } from "../src/project-config";
import { withState } from "../src/state";
import {
  type ActDeps,
  activate,
  BUTTON_MAX_AGE_MS,
  buttonEnv,
  buttons,
  buttonUrl,
  type CustomButton,
  parseButtonStatus,
  prViewFile,
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
  env: buttonEnv("w1", "app", { branch: "feat/x y", pr: 7 }, "ENG-9"),
  ...over,
});

const snap = (customs: CustomButton[]): TopSnapshot => ({ ws: "w1", dir: "/w/w1", links: [], apps: [], custom: customs });

describe("config", () => {
  const err = (yaml: string) => {
    try {
      parseConfig(yaml, "f.yml");
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
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
    expect(buttonUrl("https://c/{repo}/{branch}?pr={pr}&ws={ws}&item={item}", custom().env)).toBe("https://c/app/feat%2Fx%20y?pr=7&ws=w1&item=ENG-9");
  });

  test("an unknown item fills in empty", () => {
    expect(buttonUrl("https://c/{item}", buttonEnv("w1", "app", { branch: "main" }))).toBe("https://c/");
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

    const deps: ActDeps = {
      open: (u) => void calls.push(`open ${u}`),
      run: (cmd, dir, env) => void calls.push(`run ${cmd} in ${dir} branch=${env.OVERBRIDGE_BRANCH}`),
      spawn: () => undefined,
      start: () => undefined,
      stop: () => undefined,
      pane: () => undefined,
      cleanup: () => undefined,
      ready: () => undefined,
      merge: () => undefined,
    };

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
    // snapshotTop reads the item through the real registry, which other test files clear
    registerBuiltins();
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-buttons-")));
    process.env.OVERBRIDGE_ROOT = tmp;
    mkdirSync(join(tmp, "w1", "app"), { recursive: true });
    writeFileSync(
      join(tmp, "config.yml"),
      [
        "defaults:",
        "  project-management: { name: github, project: o/r }",
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
    expect(ran[0]).toEqual(["env", "OVERBRIDGE_NAME=w1", "OVERBRIDGE_REPO=app", "OVERBRIDGE_BRANCH=feat/12-x", "OVERBRIDGE_PR=3", "OVERBRIDGE_ITEM=12", "sh", "-c", "my-status"]);
    const snapshot = await snapshotTop("w1", {});
    expect(snapshot.custom?.[0]?.env.OVERBRIDGE_ITEM).toBe("12");
    const shown = snapshot.custom?.map((c) => [c.spec.id, c.state?.text]);
    // `quiet` printed nothing, so it stays hidden; `docs` has no status, so it always shows
    expect(shown).toEqual([
      ["checks", "green"],
      ["docs", undefined],
    ]);
  });

  describe("reuse", () => {
    const T0 = 1_700_000_000_000;

    /** A fake `exec` that answers `gh pr view` with `view()` and counts the status commands it ran. */
    const fakeExec = (view: () => object | undefined = () => undefined) => {
      const ran: string[][] = [];

      const exec = (cmd: string[]) => {
        if (cmd[0] === "gh" && cmd[1] === "pr") {
          const v = view();

          return v ? JSON.stringify(v) : undefined;
        }

        if (cmd[0] !== "env") {
          return undefined;
        }

        ran.push(cmd);

        return cmd.at(-1) === "my-status" ? `run ${ran.length}` : undefined;
      };

      return { ran, exec };
    };

    const refreshAt = (at: number, exec: (cmd: string[]) => string | undefined) => refreshTop("w1", { provider: () => fakeProvider(), exec, now: () => at });

    const refreshPausedAt = (at: number, exec: (cmd: string[]) => string | undefined) =>
      refreshTop("w1", { provider: () => fakeProvider(), exec, now: () => at, paused: "GitHub rate limit reached" });

    test("an unchanged PR view keeps the last output and runs nothing", () => {
      const { ran, exec } = fakeExec(() => ({ url: "https://github.com/o/r/pull/3", state: "OPEN" }));
      refreshAt(T0, exec);
      const cache = refreshAt(T0 + BUTTON_MAX_AGE_MS - 1, exec);
      expect(ran.length).toBe(2);
      expect(cache.buttons).toEqual({ "app/checks": { text: "run 1" } });
      expect(cache.buttonRuns?.app?.at).toBe(T0);
    });

    test("a changed PR view runs the status commands again", () => {
      let state = "OPEN";
      const { ran, exec } = fakeExec(() => ({ url: "https://github.com/o/r/pull/3", state }));
      refreshAt(T0, exec);
      state = "MERGED";
      const cache = refreshAt(T0 + 1, exec);
      expect(ran.length).toBe(4);
      expect(cache.buttons).toEqual({ "app/checks": { text: "run 3" } });
    });

    test("output older than the maximum age runs again", () => {
      const { ran, exec } = fakeExec();
      refreshAt(T0, exec);
      const cache = refreshAt(T0 + BUTTON_MAX_AGE_MS, exec);
      expect(ran.length).toBe(4);
      expect(cache.buttonRuns?.app?.at).toBe(T0 + BUTTON_MAX_AGE_MS);
    });

    test("a moved claim runs again", () => {
      const { ran, exec } = fakeExec();
      refreshAt(T0, exec);
      withState((s) => {
        s.workspaces.w1!.repos.app = { branch: "feat/12-x", pr: 4 };
      });
      refreshAt(T0 + 1, exec);
      expect(ran.length).toBe(4);
    });

    test("a paused gh runs no status command and keeps the last output", () => {
      const { ran, exec } = fakeExec();
      refreshAt(T0, exec);
      const cache = refreshPausedAt(T0 + BUTTON_MAX_AGE_MS * 2, exec);
      expect(ran.length).toBe(2);
      expect(cache.buttons).toEqual({ "app/checks": { text: "run 1" } });
    });
  });

  test("status commands get the PR view the panel read as OVERBRIDGE_PR_JSON", async () => {
    const view = { url: "https://github.com/o/r/pull/3", state: "OPEN", headRefOid: "abc" };
    const envs: string[][] = [];

    const exec = (cmd: string[]) => {
      if (cmd[0] === "gh" && cmd[1] === "pr") {
        return JSON.stringify(view);
      }

      if (cmd[0] === "env") {
        envs.push(cmd);
      }

      return undefined;
    };

    refreshTop("w1", { provider: () => fakeProvider(), exec });
    const file = prViewFile("w1", "app");
    expect(envs[0]).toContain(`OVERBRIDGE_PR_JSON=${file}`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject(view);
    expect((await snapshotTop("w1", {})).custom?.find((c) => c.spec.id === "docs")?.env.OVERBRIDGE_PR_JSON).toBe(file);

    withState((s) => {
      s.workspaces.w1!.repos.app = { branch: "feat/12-x" };
    });
    envs.length = 0;
    refreshTop("w1", { provider: () => fakeProvider(), exec });
    expect(envs[0]?.some((e) => e.startsWith("OVERBRIDGE_PR_JSON="))).toBe(false);
    expect(existsSync(file)).toBe(false);
  });
});
