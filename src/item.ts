import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { currentBranch } from "./git";
import { providerFor } from "./pm";
import { createTechDebtItem, type Provider } from "./pm/provider";
import { loadRepoConfig, type ProjectManagement } from "./project-config";
import { fail, run } from "./util";

export const ITEM_USAGE = `usage: overbridge item <action>
  view <id>                         {id,title,url} as JSON
  from-branch [branch]              the item id a branch names (default: current branch)
  branch <id> [--title t]           a branch name for the item
  assigned                          open items assigned to me, as JSON
  create --title t (--body b | --body-file f|-) [--label l]... [--parent id] [--tech-debt]
  edit <id> (--body b | --body-file f|-)`;

const body = (values: { body?: string; "body-file"?: string }): string => {
  if (values.body !== undefined) return values.body;
  const file = values["body-file"];
  if (file === undefined) fail("pass --body or --body-file (use - for stdin)");
  return readFileSync(file === "-" ? 0 : file, "utf8");
};

/**
 * Run one `item` action against `provider` and return what to print (undefined for none).
 * `branch` is the current branch, used when `from-branch` gets no argument.
 */
export function runItem(provider: Provider, pm: ProjectManagement, argv: string[], branch: () => string): string | undefined {
  const [action, ...rest] = argv;
  const json = (v: unknown) => JSON.stringify(v);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: true,
    options: {
      title: { type: "string" },
      body: { type: "string" },
      "body-file": { type: "string" },
      label: { type: "string", multiple: true },
      parent: { type: "string" },
      "tech-debt": { type: "boolean" },
    },
  });
  const id = positionals[0];
  const needId = (): string => id ?? fail(`overbridge item ${action}: an item id is required`);

  switch (action) {
    case "view": {
      const title = provider.title(needId());
      if (title === undefined) fail(`${needId()}: not found`);
      return json({ id: needId(), title, url: provider.link(needId()) });
    }
    case "from-branch": {
      const found = provider.idFromBranch(id ?? branch());
      if (!found) fail(`no ${pm.name} item in branch '${id ?? branch()}'`);
      return found;
    }
    case "branch": {
      const title = values.title ?? provider.title(needId());
      if (title === undefined) fail(`${needId()}: not found; pass --title`);
      return provider.branchName({ id: needId(), title });
    }
    case "assigned":
      return json(provider.assigned());
    case "create": {
      if (!values.title) fail("overbridge item create: --title is required");
      const item = { title: values.title, body: body(values), labels: values.label ?? [], ...(values.parent ? { parent: values.parent } : {}) };
      return json(values["tech-debt"] ? createTechDebtItem(provider, pm.techDebt, item) : provider.createItem(item));
    }
    case "edit":
      provider.updateItemBody(needId(), body(values));
      return;
    default:
      return fail(ITEM_USAGE);
  }
}

/** `overbridge item ...` for the repo in the current directory. */
export function item(argv: string[]) {
  const dir = run(["git", "rev-parse", "--show-toplevel"]).stdout || process.cwd();
  const pm = loadRepoConfig(dir).projectManagement;
  if (!pm) fail(`${dir}: no project-management in overbridge.yml (see 'overbridge config show')`);
  const out = runItem(providerFor(pm, dir), pm, argv, () => currentBranch(dir) ?? "");
  if (out !== undefined) console.log(out);
}
