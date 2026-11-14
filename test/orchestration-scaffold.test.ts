import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestrationArgs } from "../src/commands";
import { orchestratorPrompt, scaffoldOrchestration } from "../src/scaffold";

let tmp: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "overbridge-orch-")));
  process.env.OVERBRIDGE_ROOT = tmp;
});

afterAll(() => {
  if (savedRoot === undefined) {
    delete process.env.OVERBRIDGE_ROOT;
  } else {
    process.env.OVERBRIDGE_ROOT = savedRoot;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("orchestration tab scaffolding", () => {
  test("its settings install the guard and name the tab, with no workspace", () => {
    const settings = JSON.parse(readFileSync(scaffoldOrchestration("@root"), "utf8"));
    expect(settings.env).toMatchObject({ OVERBRIDGE_TAB: "@root", OVERBRIDGE_NAME: "", OVERBRIDGE_ROOT: tmp });
    const preToolUse = settings.hooks.PreToolUse;
    expect(preToolUse).toHaveLength(1);
    expect(preToolUse[0].matcher).toBe("*");
    expect(preToolUse[0].hooks.map((h: { command: string }) => h.command).join(" ")).toMatch(/ guard .* hook$/);
  });

  test("its plans are written to the meta dir, which exists and is stable across runs", () => {
    const first = readFileSync(scaffoldOrchestration("@root"), "utf8");
    const settings = JSON.parse(first);
    expect(settings.plansDirectory).toBe(join(tmp, ".overbridge", "orchestration", "plans"));
    expect(existsSync(settings.plansDirectory)).toBe(true);
    expect(readFileSync(scaffoldOrchestration("@root"), "utf8")).toBe(first);
  });

  test("its brief tells it to start a workspace with the user's request for every task", () => {
    const brief = orchestratorPrompt();
    expect(brief).toContain("never do the work yourself");
    expect(brief).toContain("overbridge start <repo> <id> --prompt");
    expect(brief).toContain("overbridge start <repo> --task");
    expect(brief).toContain("/pickup #<pr>");
  });

  test("its brief routes a PR to the workspace that already claims its branch before starting a new one", () => {
    const brief = orchestratorPrompt();
    expect(brief).toContain("overbridge status --all");
    expect(brief).toMatch(/do not start a\s+duplicate/);
    expect(brief).toContain("notify_when_idle: true");
    expect(brief).toContain("Only when no workspace claims the branch");
    expect(brief.indexOf("SendMessage")).toBeLessThan(brief.indexOf("overbridge item from-branch"));
  });

  test("claude starts with the settings and the brief appended to the system prompt", () => {
    const args = orchestrationArgs("/s.json", ["--resume"]);
    expect(args).toEqual(["claude", "--settings", "/s.json", "--append-system-prompt", orchestratorPrompt(), "--resume"]);
  });
});
