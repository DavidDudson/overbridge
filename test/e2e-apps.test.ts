import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Drives the real CLI against a temp root and a local bare remote: an overbridge.yml with a fake
 * app (a one-line Bun server), three workspaces sharing a two-port pool.
 * Providers are not involved here; `gh` and `jira` are covered by the provider unit tests.
 */

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
let tmp: string;
let root: string;
let ports: [number, number];

const env = () => ({
  ...process.env,
  OVERBRIDGE_ROOT: root,
  OVERBRIDGE_NAME: "",
  ZELLIJ_CONFIG_DIR: join(root, "zellij-config"),
  XDG_CACHE_HOME: join(tmp, "cache"),
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
});

function overbridge(args: string[]) {
  const p = Bun.spawnSync({ cmd: [process.execPath, CLI, ...args], cwd: tmp, env: env(), stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString();
  const err = p.stderr.toString();
  return { code: p.exitCode, out, err, all: out + err };
}

const app = (ws: string, ...args: string[]) => overbridge(["app", ...args, "--ws", ws]);

function sh(cmd: string[], cwd: string) {
  const p = Bun.spawnSync({ cmd, cwd, env: env(), stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${p.stderr}`);
}

/** Two TCP ports that are free right now. */
function freePorts(): [number, number] {
  const a = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const b = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const found: [number, number] = [a.port, b.port];
  a.stop(true);
  b.stop(true);
  return found;
}

const pidOf = (ws: string, id: string): number => JSON.parse(readFileSync(join(root, ws, ".overbridge", "apps", "app", `${id}.json`), "utf8")).pid;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-apps-"));
  root = join(tmp, "workspaces");
  ports = freePorts();

  const src = join(tmp, "src");
  sh(["git", "init", "-q", "-b", "main", src], tmp);
  sh(["git", "commit", "-q", "--allow-empty", "-m", "init"], src);
  const remote = join(tmp, "remote.git");
  sh(["git", "clone", "-q", "--bare", src, remote], tmp);

  expect(overbridge(["init"]).code).toBe(0);
  expect(overbridge(["repo", "add", "app", remote]).code).toBe(0);
  for (const name of ["ws1", "ws2", "ws3"]) {
    expect(overbridge(["new", name, "-r", "app"]).code).toBe(0);
    const server = `${process.execPath} -e 'Bun.serve({ port: {port}, fetch: () => new Response("ok") })'`;
    writeFileSync(
      join(root, name, "app", "overbridge.yml"),
      [
        "version: 1",
        "apps:",
        "  - id: web",
        `    start: ${JSON.stringify(server)}`,
        `    ports: [${ports.join(", ")}]`,
        '    ready: { tcp: "{port}" }',
        "  - id: boom",
        '    start: "exit 3"',
        "    ready: { tcp: 9 }",
        "",
      ].join("\n"),
    );
  }
});

afterAll(() => {
  for (const ws of ["ws1", "ws2", "ws3"]) app(ws, "web", "stop");
  rmSync(tmp, { recursive: true, force: true });
});

describe("apps end to end", () => {
  test("lists declared apps as stopped", () => {
    const r = app("ws1");
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual(["app/web: stopped", "app/boom: stopped"]);
  });

  test("start waits until ready, then status shows the port", () => {
    const r = app("ws1", "web", "start");
    expect(r.code).toBe(0);
    expect(r.err).toMatch(new RegExp(`started web \\(pid \\d+, port ${ports[0]}\\)`));
    expect(r.err).toContain("web is ready");
    expect(app("ws1", "web", "status").out.trim()).toBe(`app/web: running :${ports[0]}`);
  });

  test("starting an app that is already running is refused", () => {
    const r = app("ws1", "web", "start");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/web is already running in ws1 \(pid \d+\)/);
  });

  test("a second workspace gets the next port", () => {
    expect(app("ws2", "web", "start").code).toBe(0);
    expect(app("ws2", "web", "status").out.trim()).toBe(`app/web: running :${ports[1]}`);
  });

  test("an exhausted pool names the workspaces holding the ports", () => {
    const r = app("ws3", "web", "start");
    expect(r.code).toBe(1);
    expect(r.err).toContain(`no free port for web (${ports.join(", ")}): held by ws1:${ports[0]}, ws2:${ports[1]}`);
  });

  test("stop tears down the process and frees its port for the next workspace", () => {
    const pid = pidOf("ws1", "web");
    expect(alive(pid)).toBe(true);
    const r = app("ws1", "web", "stop");
    expect(r.code).toBe(0);
    expect(r.err).toContain("stopped web");
    expect(alive(pid)).toBe(false);
    expect(app("ws1", "web", "status").out.trim()).toBe("app/web: stopped");
    expect(app("ws3", "web", "start").code).toBe(0);
    expect(app("ws3", "web", "status").out.trim()).toBe(`app/web: running :${ports[0]}`);
  });

  test("stopping a stopped app says so", () => {
    expect(app("ws1", "web", "stop").err).toContain("web is not running");
  });

  test("an app that dies before it is ready is reported with its log", () => {
    const r = app("ws1", "boom", "start");
    expect(r.code).toBe(1);
    expect(r.err).toContain("boom exited before it was ready; see ");
    expect(r.err).toContain(join(root, "ws1", ".overbridge", "apps", "app", "boom.log"));
    expect(app("ws1", "boom", "status").out.trim()).toBe("app/boom: exited");
  });

  test("an unknown app lists the ones that exist", () => {
    const r = app("ws1", "nope", "start");
    expect(r.code).toBe(1);
    expect(r.err).toContain("no app 'nope' in ws1 (apps: web, boom)");
  });

  test("an unknown action prints usage", () => {
    const r = app("ws1", "web", "frobnicate");
    expect(r.code).toBe(1);
    expect(r.err).toContain("usage: overbridge app");
  });
});
