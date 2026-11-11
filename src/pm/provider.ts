import type { PmName, ProjectManagement } from "../project-config";

/** An issue/ticket as a provider reports it. */
export interface WorkItem {
  id: string;
  title: string;
  url: string;
}

/** Whether an item still needs work. */
export const ItemStatus = { Open: "open", Done: "done" } as const;
export type ItemStatus = (typeof ItemStatus)[keyof typeof ItemStatus];

/** What `createItem` needs to file a new item. */
export interface NewItem {
  title: string;
  body: string;
  labels?: string[];
  /** Id of a parent item (an epic). */
  parent?: string;
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
  /** Whether the item is finished (a closed issue, a ticket in a Done status); undefined when it can't be read. Hits the network. */
  status(id: string): ItemStatus | undefined;
  /** Open items assigned to me. */
  assigned(): WorkItem[];
  /**
   * The item's types, most specific first: a Jira issue type, or a GitHub issue's labels. They pick the
   * `{type}` of a branch name. Hits the network.
   */
  itemTypes(id: string): string[];
  /**
   * A branch name for `item`, from `project-management.branch` or the provider's default. Needs the network
   * only when the template uses `{type}`.
   */
  branchName(item: { id: string; title: string }): string;
  /** Workspace name for an item in `repo`, from `project-management.workspace` or the provider's default. */
  workspaceName(id: string, repo: string): string;
  /** File a new item and return it. */
  createItem(item: NewItem): WorkItem;
  /** Replace an item's body. */
  updateItemBody(id: string, body: string): void;
}

/**
 * File a tech-debt item where `project-management.tech-debt` says: under that parent item, or
 * tagged with the label when the value is `label:<name>`. Unset files it with no parent.
 */
export function createTechDebtItem(provider: Provider, techDebt: string | undefined, item: NewItem): WorkItem {
  if (techDebt?.startsWith("label:")) {
    const label = techDebt.slice("label:".length).trim();
    return provider.createItem({ ...item, labels: [...(item.labels ?? []), ...(label ? [label] : [])] });
  }
  return provider.createItem({ ...item, ...(techDebt ? { parent: techDebt } : {}) });
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

/** Fill `{name}` placeholders in a name template. Placeholders are checked when the config is read. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (whole, name: string) => vars[name] ?? whole);
}

/**
 * The `{type}` for a branch: the `branch-types` entry for the first of `types` that has one (an exact
 * match, then ignoring case), else `branch-types.default`, else `feat`.
 */
export function branchType(types: string[], map: Record<string, string> = {}): string {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  for (const type of types) {
    const found = map[type] ?? lower.get(type.toLowerCase());
    if (found) return found;
  }
  return map.default ?? "feat";
}

/**
 * Branch and workspace names from the config's templates, falling back to the provider's defaults.
 * `normalize` turns a user-typed id into the provider's form (`42` → `ENG-42`); `number` is its digits.
 */
export function namer(
  config: ProjectManagement,
  defaults: { branch: string; workspace: string },
  normalize: (id: string) => string,
  itemTypes: (id: string) => string[],
) {
  const number = (id: string) => /(\d+)\s*$/.exec(id)?.[1] ?? id;
  return {
    branchName(item: { id: string; title: string }) {
      const template = config.branch ?? defaults.branch;
      const id = normalize(item.id);
      const type = template.includes("{type}") ? branchType(itemTypes(id), config.branchTypes) : "";
      return renderTemplate(template, { id, number: number(id), slug: slug(item.title), type });
    },
    workspaceName(id: string, repo: string) {
      const normalized = normalize(id);
      return renderTemplate(config.workspace ?? defaults.workspace, { id: normalized, number: number(normalized), repo });
    },
  };
}
