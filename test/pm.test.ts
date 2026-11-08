import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cachedTitle, refreshTitle } from "../src/pm/cache";
import { slug } from "../src/pm/provider";
import { clearProviders, providerFor, registerProvider } from "../src/pm/registry";
import { fakeProvider } from "./helpers/fake-provider";

let tmp: string;
const savedRoot = process.env.OVERBRIDGE_ROOT;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "overbridge-pm-"));
  process.env.OVERBRIDGE_ROOT = tmp;
  clearProviders();
});

afterEach(() => {
  savedRoot === undefined ? delete process.env.OVERBRIDGE_ROOT : (process.env.OVERBRIDGE_ROOT = savedRoot);
  rmSync(tmp, { recursive: true, force: true });
});

describe("registry", () => {
  test("builds the registered provider", () => {
    registerProvider("github", () => fakeProvider());
    expect(providerFor({ name: "github", project: "o/r" }, tmp).name).toBe("github");
  });

  test("names what is available when a provider is missing", () => {
    registerProvider("github", () => fakeProvider());
    expect(() => providerFor({ name: "jira", project: "ENG" }, tmp)).toThrow(
      "'jira' is not available (available: github)",
    );
  });
});

describe("title cache", () => {
  const items = [{ id: "ENG-1", title: "Fix login", url: "u" }];

  test("refresh stores, cached reads without fetching", () => {
    const p = fakeProvider(items, "jira");
    expect(cachedTitle(p, "ENG", "ENG-1")).toBeUndefined();
    expect(refreshTitle(p, "ENG", "ENG-1")).toBe("Fix login");
    expect(cachedTitle(p, "ENG", "ENG-1")).toBe("Fix login");
    expect(p.calls).toBe(1);
  });

  test("a failed fetch keeps the previous title", () => {
    const p = fakeProvider(items, "jira");
    refreshTitle(p, "ENG", "ENG-1");
    expect(refreshTitle(fakeProvider([], "jira"), "ENG", "ENG-1")).toBe("Fix login");
  });

  test("keys are per provider and project", () => {
    const p = fakeProvider(items, "jira");
    refreshTitle(p, "ENG", "ENG-1");
    expect(cachedTitle(p, "OPS", "ENG-1")).toBeUndefined();
  });
});

describe("fake provider contract", () => {
  const p = fakeProvider([{ id: "12", title: "Add dark mode!", url: "u" }]);
  test("idFromBranch", () => {
    expect(p.idFromBranch("feat/12-dark-mode")).toBe("12");
    expect(p.idFromBranch("main")).toBeUndefined();
  });
  test("branchName round-trips through idFromBranch", () => {
    const branch = p.branchName({ id: "12", title: "Add dark mode!" });
    expect(branch).toBe("feat/12-add-dark-mode");
    expect(p.idFromBranch(branch)).toBe("12");
  });
});

describe("slug", () => {
  test("normalises and trims", () => {
    expect(slug("  Hello, World!! ")).toBe("hello-world");
    expect(slug("a".repeat(60), 10)).toBe("aaaaaaaaaa");
    expect(slug("ab cd ef", 6)).toBe("ab-cd");
  });
});
