import { readFileSync } from "node:fs";

/** semantic-release never commits the real version back, so package.json in git holds this placeholder. */
const PLACEHOLDER_PREFIX = "0.0.0-";

/** The version to show: package.json's when real (npm install), else the rev the nix build injects, else "dev". */
export const resolveVersion = (pkgVersion: string | undefined, envVersion: string | undefined): string =>
  pkgVersion && !pkgVersion.startsWith(PLACEHOLDER_PREFIX) ? `v${pkgVersion}` : envVersion || "dev";

const readPackageVersion = (): string | undefined => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : undefined;
  } catch {
    // The nix build ships only src/, without package.json.
    return undefined;
  }
};

/** The version of the code this process runs. */
export const overbridgeVersion = (): string => resolveVersion(readPackageVersion(), process.env.OVERBRIDGE_VERSION);
