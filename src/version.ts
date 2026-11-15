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

/** Reads a build time (seconds since epoch) from the environment; anything that is not a positive number is no build time. */
export const parseBuildTime = (raw: string | undefined): number | undefined => {
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * When this build's source was committed, which the nix build injects. Revs cannot be ordered, so this is what tells a
 * newer build from an older one. A build without it (a dev checkout) is never newer than anything.
 */
export const overbridgeBuildTime = (): number | undefined => parseBuildTime(process.env.OVERBRIDGE_BUILD_TIME);
