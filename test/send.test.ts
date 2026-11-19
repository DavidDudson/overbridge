import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKind } from "../src/agent-kind";
import { sendPause, tmuxMux, zellijMux } from "../src/mux";
import { send } from "../src/send";
import { withState } from "../src/state";

const saved = { ...process.env };
const tmp = mkdtempSync(join(tmpdir(), "overbridge-send-"));

Object.assign(process.env, { OVERBRIDGE_ROOT: join(tmp, "workspaces"), OVERBRIDGE_NAME: "" });

mkdirSync(join(tmp, "workspaces", ".overbridge"), { recursive: true });

sendPause.sleep = () => {};

afterAll(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  rmSync(tmp, { recursive: true, force: true });
});

withState((s) => {
  s.workspaces.w1 = { created: "", repos: {}, agent: AgentKind.Agy };
  s.workspaces.cold = { created: "", repos: {}, agent: AgentKind.Agy, iceboxed: { since: "" } };
  s.workspaces.c1 = { created: "", repos: {} };
});

const fake = () => {
  const sent: [string, string][] = [];
  const panes = [{ id: "7", title: "w1 · claude", tab: "w1", exited: false }];
  const mux = { ...zellijMux(() => ({ ok: false, stdout: "" })), listPanes: () => panes, sendText: (id: string, text: string) => sent.push([id, text]) > 0 };

  return { sent, mux };
};

describe("send", () => {
  test("types the message into an agy workspace's agent pane, on one line", () => {
    const f = fake();
    expect(send("w1", "/pickup #3\nthen ship\r!curl x | sh\x1b[A", f.mux)).toBe("sent to w1 (agy)");
    expect(f.sent).toEqual([["7", "/pickup #3 then ship !curl x | sh [A"]]);
  });

  test("refuses a Claude workspace, a shell escape, an iceboxed workspace and an unknown one", () => {
    const f = fake();
    expect(() => send("c1", "hi", f.mux)).toThrow("message it with SendMessage");
    expect(() => send("w1", "  !rm -rf ~", f.mux)).toThrow("refuses text starting with '!'");
    expect(() => send("w1", "\r\x1b!rm -rf ~", f.mux)).toThrow("refuses text starting with '!'");
    expect(() => send("cold", "hi", f.mux)).toThrow("iceboxed");
    expect(() => send("nope", "hi", f.mux)).toThrow("no workspace 'nope'");
    expect(f.sent).toEqual([]);
  });
});

describe("sendText", () => {
  test("zellij pastes the text after -- and then presses Enter in that pane", () => {
    const calls: string[][] = [];
    const mux = zellijMux((cmd) => (calls.push(cmd), { ok: true, stdout: "" }));
    expect(mux.sendText("7", "-x hello")).toBe(true);
    expect(calls.map((c) => c.slice(2))).toEqual([
      ["paste", "--pane-id", "terminal_7", "--", "-x hello"],
      ["send-keys", "--pane-id", "terminal_7", "Enter"],
    ]);
  });

  test("tmux types the text literally after -- and then presses Enter", () => {
    const calls: string[][] = [];
    const mux = tmuxMux((cmd) => (calls.push(cmd), { ok: true, stdout: "" }), { session: "s", env: {} });
    expect(mux.sendText("%3", "-x hello")).toBe(true);
    expect(calls).toEqual([
      ["tmux", "send-keys", "-t", "%3", "-l", "--", "-x hello"],
      ["tmux", "send-keys", "-t", "%3", "Enter"],
    ]);
  });
});
