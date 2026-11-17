import { describe, expect, test } from "bun:test";
import { isNewerRelease, parseBuildTime, resolveVersion } from "../src/version";

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

describe("parseBuildTime", () => {
  test("a positive number of seconds is a build time", () => {
    expect(parseBuildTime("1763200000")).toBe(1763200000);
  });

  test("anything else is none", () => {
    for (const raw of [undefined, "", "0", "-5", "soon", "NaN"]) expect(parseBuildTime(raw)).toBeUndefined();
  });
});

describe("isNewerRelease", () => {
  test("a later major, minor or patch release is newer", () => {
    expect(isNewerRelease("v1.54.0", "v1.49.0")).toBe(true);
    expect(isNewerRelease("v2.0.0", "v1.99.99")).toBe(true);
    expect(isNewerRelease("v1.49.1", "v1.49.0")).toBe(true);
    expect(isNewerRelease("v1.10.0", "v1.9.0")).toBe(true);
  });

  test("the same or an older release is not newer", () => {
    expect(isNewerRelease("v1.49.0", "v1.49.0")).toBe(false);
    expect(isNewerRelease("v1.49.0", "v1.54.0")).toBe(false);
  });

  test("a rev or a dev build on either side cannot be ordered", () => {
    for (const [a, b] of [["3870b2a", "v1.0.0"], ["v2.0.0", "3870b2a"], ["dev", "v1.0.0"], ["v2.0.0", "dev"], ["v2.0.0-beta.1", "v1.0.0"]]) {
      expect(isNewerRelease(a!, b!)).toBe(false);
    }
  });
});
