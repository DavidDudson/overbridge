import type { PmName, ProjectManagement } from "../project-config";

/** An issue/ticket as a provider reports it. */
export interface WorkItem {
  id: string;
  title: string;
  url: string;
}

/**
 * A project-management backend. Everything else in overbridge talks to this
 * interface and never branches on the provider name. Calls are synchronous like
 * the rest of the CLI; `title` hits the network, so renderers use `cachedTitle`.
 */
export interface Provider {
  readonly name: PmName;
  /** The item id a branch name refers to, e.g. `feat/ENG-12-x` or `12-x`. */
  idFromBranch(branch: string): string | undefined;
  /** Web URL for an item. */
  link(id: string): string;
  /** Fetch an item's title from the backend. */
  title(id: string): string | undefined;
  /** Open items assigned to me. */
  assigned(): WorkItem[];
  /** A branch name that follows the provider's convention for `item`. */
  branchName(item: { id: string; title: string }): string;
}

/** Builds a provider for a repo's `project-management` block; `cwd` is a worktree of that repo. */
export type ProviderFactory = (config: ProjectManagement, cwd: string) => Provider;

/** Lowercase, hyphen-separated slug of `text`, at most `max` characters, never ending in a hyphen. */
export function slug(text: string, max = 40): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}
