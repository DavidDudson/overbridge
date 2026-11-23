import { expect, test } from "bun:test";
import { sessionName } from "../src/paths";

test("tests never reach the multiplexer session they run in", () => {
  for (const key of ["TMUX", "TMUX_PANE", "OVERBRIDGE_MUX", "ZELLIJ", "ZELLIJ_SESSION_NAME", "ZELLIJ_PANE_ID"]) {
    expect(process.env[key]).toBeUndefined();
  }

  expect(sessionName()).toStartWith("overbridge-test-");
});
