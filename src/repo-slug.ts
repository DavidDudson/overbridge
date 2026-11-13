import { run } from "./util";

/** `owner/name` of a GitHub remote URL (ssh or https), or undefined for any other host. */
export function ownerRepo(url: string): string | undefined {
  return /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url)?.slice(1, 3).join("/");
}

/** `owner/name` of the repo checked out in `dir`, from its `origin` remote (a local read, about 2 ms). */
export function slugOfDir(dir: string): string | undefined {
  const r = run(["git", "-C", dir, "remote", "get-url", "origin"]);
  return r.ok ? ownerRepo(r.stdout.trim()) : undefined;
}
