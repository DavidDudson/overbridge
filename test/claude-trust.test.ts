import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPath, trustFolder, untrustFolder } from "../src/claude-trust";
import { createWorkspace, removeWorkspace } from "../src/commands";
import { root, wsDir } from "../src/paths";

const saved = { ...process.env };
const tmp = mkdtempSync(join(tmpdir(), "overbridge-trust-"));
Object.assign(process.env, { OVERBRIDGE_ROOT: join(tmp, "workspaces"), OVERBRIDGE_NAME: "", CLAUDE_CONFIG_DIR: join(tmp, "claude") });
mkdirSync(join(tmp, "workspaces"), { recursive: true });
mkdirSync(join(tmp, "claude"), { recursive: true });

const readConfig = () => JSON.parse(readFileSync(claudeConfigPath(), "utf8"));
const writeConfig = (config: unknown) => writeFileSync(claudeConfigPath(), JSON.stringify(config));

beforeEach(() => rmSync(claudeConfigPath(), { force: true }));

afterAll(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) {
      delete process.env[k];
    }
  }
  Object.assign(process.env, saved);
  rmSync(tmp, { recursive: true, force: true });
});

describe("trustFolder", () => {
  test("creates the config when Claude has not written one yet", () => {
    trustFolder(wsDir("a"));
    expect(readConfig()).toEqual({ projects: { [wsDir("a")]: { hasTrustDialogAccepted: true } } });
  });

  test("keeps every other key Claude wrote", () => {
    const other = join(tmp, "elsewhere");
    writeConfig({ numStartups: 3, projects: { [other]: { allowedTools: ["x"] }, [wsDir("a")]: { lastCost: 1 } } });
    trustFolder(wsDir("a"));
    expect(readConfig()).toEqual({
      numStartups: 3,
      projects: { [other]: { allowedTools: ["x"] }, [wsDir("a")]: { lastCost: 1, hasTrustDialogAccepted: true } },
    });
  });

  test("does not rewrite the file when the folder is already trusted", () => {
    const body = JSON.stringify({ projects: { [wsDir("a")]: { hasTrustDialogAccepted: true } } });
    writeFileSync(claudeConfigPath(), body);
    trustFolder(wsDir("a"));
    expect(readFileSync(claudeConfigPath(), "utf8")).toBe(body);
  });

  test.each([
    ["the root itself", () => root()],
    ["a folder outside the root", () => join(tmp, "elsewhere")],
  ])("refuses %s and leaves the file alone", (_, dir) => {
    writeConfig({ projects: {} });
    expect(() => trustFolder(dir())).toThrow("refusing to change Claude trust");
    expect(readConfig()).toEqual({ projects: {} });
  });

  test("leaves a config it cannot parse alone", () => {
    writeFileSync(claudeConfigPath(), "{ not json");
    trustFolder(wsDir("a"));
    expect(readFileSync(claudeConfigPath(), "utf8")).toBe("{ not json");
  });
});

describe("untrustFolder", () => {
  test("drops the entry once only the trust key was in it", () => {
    writeConfig({ projects: { [wsDir("a")]: { hasTrustDialogAccepted: true }, [wsDir("b")]: { hasTrustDialogAccepted: true } } });
    untrustFolder(wsDir("a"));
    expect(readConfig()).toEqual({ projects: { [wsDir("b")]: { hasTrustDialogAccepted: true } } });
  });

  test("keeps the other keys Claude wrote for the folder", () => {
    writeConfig({ projects: { [wsDir("a")]: { hasTrustDialogAccepted: true, lastCost: 1 } } });
    untrustFolder(wsDir("a"));
    expect(readConfig()).toEqual({ projects: { [wsDir("a")]: { lastCost: 1 } } });
  });

  test("does nothing when there is no config", () => {
    untrustFolder(wsDir("a"));
    expect(existsSync(claudeConfigPath())).toBe(false);
  });
});

describe("workspace lifecycle", () => {
  test("a new workspace is trusted and removing it drops the trust", () => {
    createWorkspace("trusted", []);
    expect(readConfig().projects[wsDir("trusted")]).toEqual({ hasTrustDialogAccepted: true });
    removeWorkspace("trusted", false);
    expect(readConfig().projects).toEqual({});
  });
});
