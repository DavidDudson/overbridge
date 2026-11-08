import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocatePort,
  AppStatus,
  appStatus,
  groupAlive,
  logPath,
  portFree,
  processAlive,
  readRecord,
  startApp,
  stopApp,
  withPort,
} from "../src/apps";
import { parseConfig, type AppSpec } from "../src/project-config";
import { withState } from "../src/state";

let tmp: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;
const started: { ws: string; spec: AppSpec }[] = [];

const dirOf = (ws: string) => join(tmp, ws, "app");

/** A spec through the real config parser, so the fixtures stay valid. */
function spec(yaml: string): AppSpec {
  return parseConfig(`apps:\n  - id: srv\n${yaml.replace(/^/gm, "    ")}`).apps[0]!;
}

/** `n` distinct ports nothing is listening on. */
function freePorts(n: number): number[] {
  const servers = Array.from({ length: n }, () => Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }));
  const ports = servers.map((s) => s.port);
  servers.forEach((s) => s.stop(true));
  return ports;
}

function start(ws: string, s: AppSpec) {
  const record = startApp(ws, "app", s, dirOf(ws));
  started.push({ ws, spec: s });
  return record;
}

const alive = processAlive;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-apps-"));
  process.env.OVERBRIDGE_ROOT = tmp;
  for (const ws of ["ws1", "ws2", "ws3"]) mkdirSync(dirOf(ws), { recursive: true });
  withState((s) => {
    for (const ws of ["ws1", "ws2", "ws3"]) s.workspaces[ws] = { created: "", repos: { app: {} } };
  });
});

afterEach(() => {
  for (const { ws, spec: s } of started.splice(0)) {
    try {
      stopApp(ws, "app", s, dirOf(ws));
    } catch {
      // already stopped
    }
  }
  savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
  rmSync(tmp, { recursive: true, force: true });
});

describe("lifecycle", () => {
  test("start records pid and port, logs output, stop removes both", async () => {
    const [port] = freePorts(1) as [number];
    const s = spec(`start: echo up on {port}; exec sleep 300\nports: [${port}]`);
    const record = start("ws1", s);
    expect(record.port).toBe(port);
    expect(alive(record.pid)).toBe(true);
    expect(readRecord("ws1", "app", "srv")?.pid).toBe(record.pid);
    expect(await appStatus("ws1", "app", s)).toBe(AppStatus.Running);

    await Bun.sleep(150);
    expect(readFileSync(logPath("ws1", "app", "srv"), "utf8")).toContain(`up on ${port}`);

    expect(stopApp("ws1", "app", s, dirOf("ws1"))).toBe(true);
    expect(alive(record.pid)).toBe(false);
    expect(readRecord("ws1", "app", "srv")).toBeUndefined();
    expect(await appStatus("ws1", "app", s)).toBe(AppStatus.Stopped);
  });

  test("stop takes down the whole process tree", () => {
    const s = spec("start: sleep 300 & sleep 300 & wait");
    const { pid } = start("ws1", s);
    expect(groupAlive(pid)).toBe(true);
    stopApp("ws1", "app", s, dirOf("ws1"));
    expect(groupAlive(pid)).toBe(false);
  });

  test("a stop command runs in the app dir with the port, then the group is cleaned up", () => {
    const [port] = freePorts(1) as [number];
    const s = spec(`start: exec sleep 300\nstop: echo stopped-{port} > stopped.txt\nports: [${port}]`);
    const { pid } = start("ws1", s);
    stopApp("ws1", "app", s, dirOf("ws1"));
    expect(readFileSync(join(dirOf("ws1"), "stopped.txt"), "utf8").trim()).toBe(`stopped-${port}`);
    expect(alive(pid)).toBe(false);
  });

  test("stopping something that is not running is a no-op", () => {
    expect(stopApp("ws1", "app", spec("start: \"true\""), dirOf("ws1"))).toBe(false);
  });

  test("a crashed app reads as exited", async () => {
    const s = spec("start: exit 3");
    start("ws1", s);
    await Bun.sleep(300);
    expect(await appStatus("ws1", "app", s)).toBe(AppStatus.Exited);
  });

  test("refuses to start twice", () => {
    const s = spec("start: exec sleep 300");
    start("ws1", s);
    expect(() => startApp("ws1", "app", s, dirOf("ws1"))).toThrow("already running in ws1");
  });

  test("a failing prepare stops the start and points at the log", () => {
    const s = spec("prepare: echo nope; exit 1\nstart: exec sleep 300");
    expect(() => startApp("ws1", "app", s, dirOf("ws1"))).toThrow(/prepare failed \(exit 1\)/);
    expect(readRecord("ws1", "app", "srv")).toBeUndefined();
    expect(readFileSync(logPath("ws1", "app", "srv"), "utf8")).toContain("nope");
  });

  test("prepare finishes before start", () => {
    const s = spec("prepare: echo ready > flag.txt\nstart: test -f flag.txt && exec sleep 300");
    const { pid } = start("ws1", s);
    expect(existsSync(join(dirOf("ws1"), "flag.txt"))).toBe(true);
    expect(alive(pid)).toBe(true);
  });
});

describe("ports", () => {
  test("each workspace gets the next port; exhaustion names the holders", () => {
    const [a, b] = freePorts(2) as [number, number];
    const s = spec(`start: exec sleep 300\nports: [${a}, ${b}]`);
    expect(start("ws1", s).port).toBe(a);
    expect(start("ws2", s).port).toBe(b);
    expect(() => allocatePort(s, "app")).toThrow(`held by ws1:${a}, ws2:${b}`);
    expect(() => startApp("ws3", "app", s, dirOf("ws3"))).toThrow("no free port for srv");
  });

  test("a port freed by stop is handed out again", () => {
    const [a] = freePorts(1) as [number];
    const s = spec(`start: exec sleep 300\nports: [${a}]`);
    start("ws1", s);
    stopApp("ws1", "app", s, dirOf("ws1"));
    expect(allocatePort(s, "app")).toBe(a);
  });

  test("a port in use by something else is skipped", () => {
    const [a, b] = freePorts(2) as [number, number];
    const squatter = Bun.listen({ hostname: "127.0.0.1", port: a, socket: { data() {} } });
    try {
      expect(portFree(a)).toBe(false);
      expect(allocatePort(spec(`start: "true"\nports: [${a}, ${b}]`), "app")).toBe(b);
      expect(() => allocatePort(spec(`start: "true"\nports: [${a}]`), "app")).toThrow("in use by other processes");
    } finally {
      squatter.stop(true);
    }
  });

  test("apps without ports get none", () => {
    expect(allocatePort(spec("start: \"true\""), "app")).toBeUndefined();
  });

  test("withPort fills every placeholder", () => {
    expect(withPort("a {port} b {port}", 8)).toBe("a 8 b 8");
  });
});

describe("ready checks", () => {
  test("http: starting until something answers, then running", async () => {
    const [port] = freePorts(1) as [number];
    const s = spec(`start: exec sleep 300\nready:\n  http: http://127.0.0.1:${port}/`);
    start("ws1", s);
    expect(await appStatus("ws1", "app", s)).toBe(AppStatus.Starting);
    const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("ok") });
    try {
      expect(await appStatus("ws1", "app", s)).toBe(AppStatus.Running);
    } finally {
      server.stop(true);
    }
  });

  test("tcp on the allocated port", async () => {
    const [port] = freePorts(1) as [number];
    const s = spec(`start: exec sleep 300\nports: [${port}]\nready:\n  tcp: "{port}"`);
    start("ws1", s);
    expect(await appStatus("ws1", "app", s)).toBe(AppStatus.Starting);
    const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
    try {
      expect(await appStatus("ws1", "app", s)).toBe(AppStatus.Running);
    } finally {
      server.stop(true);
    }
  });
});
