import { describe, expect, test } from "bun:test";
import { AGENT_STABLE_MS, AGENT_UP_MS, agentCameUp, requireAgent, type VerifyDeps } from "../src/agent-verify";
import { zellijMux } from "../src/mux";
import { OverbridgeError } from "../src/util";

const LIVE = { pid: 1, child: 2 };

/** A clock that only moves when `sleep` is called, and a launcher that is live from `upAtMs`, or after `flaps` breaks. */
function world(upAtMs: number | undefined, opts: { dropAtMs?: number } = {}) {
  let t = 0;
  const reopened: string[] = [];

  const deps: VerifyDeps = {
    launcher: () => (upAtMs !== undefined && t >= upAtMs && (opts.dropAtMs === undefined || t < opts.dropAtMs) ? LIVE : undefined),
    now: () => t,
    sleep: (ms) => void (t += ms),
    reopen: (ws) => reopened.push(ws) > 0,
    retries: 2,
  };

  return { deps, reopened, at: () => t };
}

const inSession = zellijMux(() => ({ ok: true, stdout: "", stderr: "" }), { env: { ZELLIJ: "0" } });
const outside = zellijMux(() => ({ ok: true, stdout: "", stderr: "" }), { env: {} });

describe("agentCameUp", () => {
  test("an agent that registers and stays up counts", () => {
    const w = world(1_000);
    expect(agentCameUp("w1", w.deps)).toBe(true);
    expect(w.at()).toBeGreaterThanOrEqual(1_000 + AGENT_STABLE_MS);
  });

  test("an agent that registers and dies inside the stable window does not", () => {
    const w = world(0, { dropAtMs: AGENT_STABLE_MS - 500 });
    expect(agentCameUp("w1", w.deps)).toBe(false);
  });

  test("no agent ever: gives up after the deadline", () => {
    const w = world(undefined);
    expect(agentCameUp("w1", w.deps)).toBe(false);
    expect(w.at()).toBeGreaterThanOrEqual(AGENT_UP_MS);
  });
});

describe("requireAgent", () => {
  test("a healthy start needs no reopen", () => {
    const w = world(0);
    requireAgent("w1", inSession, w.deps);
    expect(w.reopened).toEqual([]);
  });

  test("a pane that never started is reopened, and a later success is accepted", () => {
    let t = 0;
    const reopened: string[] = [];

    requireAgent("w1", inSession, {
      launcher: () => (reopened.length ? LIVE : undefined),
      now: () => t,
      sleep: (ms) => void (t += ms),
      reopen: (ws) => reopened.push(ws) > 0,
      retries: 2,
    });
    expect(reopened).toEqual(["w1"]);
  });

  test("an agent that never comes up fails loudly, naming the recovery", () => {
    const w = world(undefined);
    expect(() => requireAgent("w1", inSession, w.deps)).toThrow(OverbridgeError);
    expect(() => requireAgent("w1", inSession, world(undefined).deps)).toThrow("relaunch w1 --fresh --force");
    expect(w.reopened).toEqual(["w1", "w1"]);
  });

  test("back-to-back starts are judged one by one: a live neighbour never vouches for a dead agent", () => {
    let t = 0;
    const reopened: string[] = [];

    const deps: VerifyDeps = {
      launcher: (ws) => (ws === "first" ? LIVE : undefined),
      now: () => t,
      sleep: (ms) => void (t += ms),
      reopen: (ws) => reopened.push(ws) > 0,
      retries: 1,
    };

    requireAgent("first", inSession, deps);
    expect(() => requireAgent("second", inSession, deps)).toThrow("second's agent did not start");
    expect(reopened).toEqual(["second"]);
  });

  test("outside a multiplexer session there is nothing to verify", () => {
    const w = world(undefined);
    requireAgent("w1", outside, w.deps);
    expect(w.at()).toBe(0);
  });
});
