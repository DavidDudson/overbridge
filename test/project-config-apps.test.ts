import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/project-config";

const app = (body: string) => parseConfig(`apps:\n  - id: web\n${body.replace(/^/gm, "    ")}`).apps[0]!;
const err = (body: string): string => {
  try {
    app(body);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a validation error");
};

describe("app defaults", () => {
  test("only id and start are required", () => {
    expect(app("start: pnpm dev")).toEqual({ id: "web", label: "web", dir: ".", start: "pnpm dev", ports: [], open: false, when: "always" });
  });
});

describe("full app", () => {
  test("every key is normalised", () => {
    const a = app(`label: Web
dir: apps/web
prepare: pnpm build
start: pnpm dev --port {port}
stop: pnpm stop
ports: [3000, 3001]
ready:
  http: http://localhost:{port}/health
open: true
when: feature-branch`);
    expect(a).toEqual({
      id: "web",
      label: "Web",
      dir: "apps/web",
      prepare: "pnpm build",
      start: "pnpm dev --port {port}",
      stop: "pnpm stop",
      ports: [3000, 3001],
      ready: { kind: "http", url: "http://localhost:{port}/health" },
      open: true,
      when: "feature-branch",
    });
  });

  test("stop: ~ means no stop command", () => {
    expect(app("start: x\nstop: ~").stop).toBeUndefined();
  });

  test("tcp ready accepts {port} or a fixed port", () => {
    expect(app('start: x\nports: [1000]\nready:\n  tcp: "{port}"').ready).toEqual({ kind: "tcp" });
    expect(app("start: x\nready:\n  tcp: 5432").ready).toEqual({ kind: "tcp", port: 5432 });
  });
});

describe("app errors", () => {
  test("{port} without a pool", () => {
    expect(err("start: dev --port {port}")).toContain("apps[0].ports: required when a command or ready url uses {port}");
    expect(err("start: x\nready:\n  http: http://localhost:{port}")).toContain("apps[0].ports: required");
  });

  test("bad ports", () => {
    expect(err("start: x\nports: [0]")).toContain("expected a list of ports (1-65535)");
    expect(err("start: x\nports: [80, 80]")).toContain("duplicate port");
    expect(err("start: x\nports: 80")).toContain("expected a list of ports");
  });

  test("ready needs exactly one of http or tcp", () => {
    expect(err("start: x\nready: {}")).toContain("set exactly one of http or tcp");
    expect(err("start: x\nready: { http: a, tcp: 1 }")).toContain("set exactly one of http or tcp");
    expect(err("start: x\nready: { htp: a }")).toContain("did you mean 'http'?");
  });

  test("tcp {port} needs a pool", () => {
    expect(err('start: x\nready:\n  tcp: "{port}"')).toContain("{port} needs ports");
  });

  test("when and open are checked", () => {
    expect(err("start: x\nwhen: sometimes")).toContain("apps[0].when: expected one of always, feature-branch");
    expect(err("start: x\nopen: maybe")).toContain("apps[0].open: expected true or false");
  });
});
