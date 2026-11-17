import { readFileSync } from "node:fs";
import { isJsonObject, isJsonString } from "./json";

/** semantic-release never commits the real version back, so package.json in git holds this placeholder. */
const PLACEHOLDER_PREFIX = "0.0.0-";

/** The version to show: package.json's when real (npm install), else the rev the nix build injects, else "dev". */
export const resolveVersion = (pkgVersion: string | undefined, envVersion: string | undefined): string =>
  pkgVersion && !pkgVersion.startsWith(PLACEHOLDER_PREFIX) ? `v${pkgVersion}` : envVersion || "dev";

const readPackageVersion = (): string | undefined => {
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    return isJsonObject(pkg) && isJsonString(pkg.version) ? pkg.version : undefined;
  } catch {
    // The nix build ships only src/, without package.json.
    return undefined;
  }
};

/** The version of the code this process runs. */
export const overbridgeVersion = (): string => resolveVersion(readPackageVersion(), process.env.OVERBRIDGE_VERSION);

/** A release version as `resolveVersion` shows it; a rev or `dev` does not match. */
const RELEASE_RE = /^v(\d+)\.(\d+)\.(\d+)$/;

const releaseParts = (version: string): number[] | undefined => RELEASE_RE.exec(version)?.slice(1).map(Number);

/** Whether `candidate` is a later release than `current`. A rev or `dev` on either side cannot be ordered, so it is never newer. */
export function isNewerRelease(candidate: string, current: string): boolean {
  const candidateParts = releaseParts(candidate);
  const currentParts = releaseParts(current);

  if (!candidateParts || !currentParts) {
    return false;
  }

  const diff = candidateParts.map((n, i) => n - (currentParts[i] ?? 0)).find((d) => d !== 0);

  return diff !== undefined && diff > 0;
}

/** The identity a client and the server compare. */
export interface BuildId {
  version: string;
  /** Seconds since epoch; absent on a build without one (a pnpm install, a dev checkout). */
  buildTime?: number | undefined;
}

/** Whether `client` may replace `server`: its build time or its release version is strictly later. */
export const shouldReplace = (client: BuildId, server: BuildId): boolean =>
  (server.buildTime !== undefined && client.buildTime !== undefined && client.buildTime > server.buildTime) || isNewerRelease(client.version, server.version);

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
