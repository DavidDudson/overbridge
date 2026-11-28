import { describe, expect, test } from "bun:test";
import { stopAgent, writeLauncher } from "../src/agent-supervisor";

describe("stopAgent", () => {
  test("signals the supervisor first, then the agent, skipping dead pids", () => {
    const ws = `stop-${process.pid}`;
    writeLauncher(ws, { pid: 11, child: 22 });
    const killed: number[] = [];
    expect(stopAgent(ws, () => true, (p) => void killed.push(p))).toEqual([11, 22]);
    expect(killed).toEqual([11, 22]);
    killed.length = 0;
    expect(stopAgent(ws, (p) => p === 22, (p) => void killed.push(p))).toEqual([22]);
  });

  test("does nothing without a launcher, and survives a kill that throws", () => {
    expect(stopAgent("no-such-ws", () => true, () => {})).toEqual([]);
    const ws = `stop2-${process.pid}`;
    writeLauncher(ws, { pid: 1, child: 2 });
    expect(stopAgent(ws, () => true, () => { throw new Error("ESRCH"); })).toEqual([1, 2]);
  });
});
