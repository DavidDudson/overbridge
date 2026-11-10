import { describe, expect, test } from "bun:test";
import { resolveVersion } from "../src/version";

describe("resolveVersion", () => {
  test("a real package.json version wins", () => {
    expect(resolveVersion("1.11.1", "3870b2a")).toBe("v1.11.1");
  });

  test("the semantic-release placeholder falls back to the injected rev", () => {
    expect(resolveVersion("0.0.0-semantic-release", "3870b2a")).toBe("3870b2a");
  });

  test("no package.json falls back to the injected rev", () => {
    expect(resolveVersion(undefined, "3870b2a")).toBe("3870b2a");
  });

  test("with neither, it is dev", () => {
    expect(resolveVersion("0.0.0-semantic-release", undefined)).toBe("dev");
    expect(resolveVersion(undefined, "")).toBe("dev");
  });
});
