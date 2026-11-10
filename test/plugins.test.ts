import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../src/paths";
import { pluginProblems, pluginSettings } from "../src/plugins";

const tmp = mkdtempSync(join(tmpdir(), "overbridge-plugins-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ENABLED = { "overbridge@overbridge": true, "overbridge-review@overbridge": true };
const none = () => [];

describe("pluginSettings", () => {
  test("registers the installed package as a directory marketplace and enables both plugins", () => {
    expect(pluginSettings()).toEqual({
      extraKnownMarketplaces: { overbridge: { source: { source: "directory", path: packageRoot() } } },
      enabledPlugins: ENABLED,
    });
  });

  test("is empty for a package without a marketplace", () => {
    expect(pluginSettings(tmp)).toEqual({});
  });
});

describe("pluginProblems", () => {
  test("none for this checkout with no clashing marketplace", () => {
    expect(pluginProblems(packageRoot(), none)).toEqual({ errors: [], warnings: [] });
  });

  test("a matching directory marketplace is not a clash", () => {
    const known = () => [{ name: "overbridge", source: "directory", path: packageRoot() }];
    expect(pluginProblems(packageRoot(), known).warnings).toEqual([]);
  });

  test("a package without a marketplace is an error with a fix", () => {
    const { errors } = pluginProblems(join(tmp, "empty"), none);
    expect(errors[0]).toContain("marketplace.json is missing");
    expect(errors[0]).toContain("Reinstall overbridge");
  });

  test("a marketplace naming a missing plugin folder is an error", () => {
    const root = join(tmp, "partial");
    cpSync(join(packageRoot(), ".claude-plugin"), join(root, ".claude-plugin"), { recursive: true });
    cpSync(join(packageRoot(), "plugin"), join(root, "plugin"), { recursive: true });
    expect(pluginProblems(root, none).errors).toEqual([`plugin folder ${join(root, "plugin-review")} is missing. Reinstall overbridge.`]);
  });

  test("an overbridge marketplace from elsewhere is a warning with the remove command", () => {
    const known = () => [{ name: "overbridge", source: "github", repo: "DavidDudson/overbridge" }];
    const { errors, warnings } = pluginProblems(packageRoot(), known);
    expect(errors).toEqual([]);
    expect(warnings[0]).toContain("from DavidDudson/overbridge");
    expect(warnings[0]).toContain("claude plugin marketplace remove overbridge");
  });
});
