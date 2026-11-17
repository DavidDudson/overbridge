import { describe, expect, test } from "bun:test";
import { isNewerRelease, parseBuildTime, resolveVersion, shouldReplace } from "../src/version";

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
    expect(isNewerRelease("v1.99.0", "v2.0.0")).toBe(false);
    expect(isNewerRelease("v1.48.9", "v1.49.0")).toBe(false);
  });

  test("a rev or a dev build on either side cannot be ordered", () => {
    const unordered: [string, string][] = [["3870b2a", "v1.0.0"], ["v2.0.0", "3870b2a"], ["dev", "v1.0.0"], ["v2.0.0", "dev"], ["v2.0.0-beta.1", "v1.0.0"]];

    for (const [candidate, current] of unordered) {
      expect(isNewerRelease(candidate, current)).toBe(false);
    }
  });
});

describe("shouldReplace", () => {
  test("a later build time or a later release replaces", () => {
    expect(shouldReplace({ version: "abc", buildTime: 2 }, { version: "def", buildTime: 1 })).toBe(true);
    expect(shouldReplace({ version: "v1.2.0" }, { version: "v1.1.0", buildTime: 5 })).toBe(true);
  });

  test("a build time against a server with none, or an older release, does not", () => {
    expect(shouldReplace({ version: "abc", buildTime: 2 }, { version: "def" })).toBe(false);
    expect(shouldReplace({ version: "v1.1.0", buildTime: 1 }, { version: "v1.2.0", buildTime: 2 })).toBe(false);
  });
});
