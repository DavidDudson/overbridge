import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspace, repoAdd } from "../src/commands";
import { rootConfigPath } from "../src/project-config";
import { scaffold, workspaceSettingsPath } from "../src/scaffold";

let tmp: string;

const saved = { ...process.env };

const sh = (cmd: string[], cwd: string) => {
  const p = Bun.spawnSync({ cmd, cwd, env: process.env, stdout: "pipe", stderr: "pipe" });

  if (p.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
  }
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-mcp-"));
  Object.assign(process.env, {
    OVERBRIDGE_ROOT: join(tmp, "workspaces"),
    OVERBRIDGE_NAME: "",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
    GIT_CONFIG_GLOBAL: "/dev/null",
  });
  const src = join(tmp, "src");
  sh(["git", "init", "-q", "-b", "main", src], tmp);
  sh(["git", "commit", "-q", "--allow-empty", "-m", "init"], src);
  sh(["git", "clone", "-q", "--bare", src, join(tmp, "remote.git")], tmp);
  repoAdd("app", join(tmp, "remote.git"));
  repoAdd("lib", join(tmp, "remote.git"));
  createWorkspace("ws1", ["app", "lib"]);
  createWorkspace("ws2", []);
});

afterAll(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in saved)) {
      delete process.env[k];
    }
  }

  Object.assign(process.env, saved);
  rmSync(tmp, { recursive: true, force: true });
});

const settingsOf = (ws: string) => {
  scaffold(ws);

  return {
    copy: JSON.parse(readFileSync(workspaceSettingsPath(ws), "utf8")),
    local: JSON.parse(readFileSync(join(tmp, "workspaces", ws, ".claude", "settings.json"), "utf8")),
  };
};

describe("mcp-servers", () => {
  test("approves the agent repo's listed .mcp.json servers in the workspace settings", () => {
    writeFileSync(rootConfigPath(), "repos:\n  app:\n    mcp-servers: [playwright, nx]\n  lib:\n    mcp-servers: [other]\n");
    const { copy, local } = settingsOf("ws1");
    expect(copy.enabledMcpjsonServers).toEqual(["playwright", "nx"]);
    expect(local.enabledMcpjsonServers).toEqual(["playwright", "nx"]);
    expect(copy.enableAllProjectMcpServers).toBeUndefined();
  });

  test("approves nothing when the repo lists no servers or the workspace has no repo", () => {
    writeFileSync(rootConfigPath(), "repos:\n  lib:\n    mcp-servers: [other]\n");
    expect(settingsOf("ws1").copy.enabledMcpjsonServers).toBeUndefined();
    expect(settingsOf("ws2").copy.enabledMcpjsonServers).toBeUndefined();
  });

  test("approves nothing when the config does not load, and still writes the settings", () => {
    writeFileSync(rootConfigPath(), "repos:\n  app:\n    mcp-servers: nope\n");
    expect(settingsOf("ws1").copy.enabledMcpjsonServers).toBeUndefined();
  });

  test("a repo's own overbridge.yml can't change the list, even when it doesn't load", () => {
    writeFileSync(rootConfigPath(), "repos:\n  app:\n    mcp-servers: [playwright]\n");
    const repoFile = join(tmp, "workspaces", "ws1", "app", "overbridge.yml");
    writeFileSync(repoFile, "version: 1\nmcp-servers: ~\n");
    expect(settingsOf("ws1").copy.enabledMcpjsonServers).toEqual(["playwright"]);
    writeFileSync(repoFile, "version: 1\nmcp-servers: [evil]\nnot-a-key: 1\n");
    expect(settingsOf("ws1").copy.enabledMcpjsonServers).toEqual(["playwright"]);
    rmSync(repoFile);
  });
});
