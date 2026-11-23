import type { ItemNode, NewItem, Provider, WorkItem } from "../../src/pm/provider";
import { ItemStatus, slug } from "../../src/pm/provider";

export type FakeCreated = NewItem & { id: string };

/** In-memory provider for tests. `calls` counts `title` fetches; `created` records `createItem` calls; `parents` maps an item id to its parent's. */
export function fakeProvider(
  items: WorkItem[] = [],
  name: "github" | "jira" = "github",
  done: readonly string[] = [],
  parents: Readonly<Record<string, string>> = {},
): Provider & { calls: number; created: FakeCreated[]; bodies: Map<string, string> } {
  const byId = new Map(items.map((i) => [i.id, i]));
  const bodies = new Map<string, string>();
  const created: FakeCreated[] = [];
  let next = 1000;

  return {
    name,
    calls: 0,
    created,
    bodies,
    idFromBranch: (branch) => /(?:^|\/)([A-Z]+-\d+|\d+)(?:-|$)/.exec(branch)?.[1],
    link: (id) => `https://fake.test/items/${id}`,
    title(id) {
      this.calls++;

      return byId.get(id)?.title;
    },
    status: (id) => (done.includes(id) ? ItemStatus.Done : byId.has(id) ? ItemStatus.Open : undefined),
    lineage(id) {
      const climb = (key: string, seen: readonly string[]): ItemNode[] => {
        const item = byId.get(key);

        if (!item || seen.includes(key)) {
          return [];
        }

        const parent = parents[key];
        const node: ItemNode = { id: key, title: item.title, status: done.includes(key) ? "Done" : "Open", url: `https://fake.test/items/${key}` };

        return [...(parent ? climb(parent, [...seen, key]) : []), node];
      };

      return climb(id, []);
    },
    assigned: () => items,
    itemTypes: () => [],
    branchName: (item) => `feat/${item.id}-${slug(item.title)}`,
    workspaceName: (id, repo) => (name === "jira" ? id : `gh-${repo}-${id}`),
    createItem(item) {
      const id = String(next++);
      const work = { id, title: item.title, url: `https://fake.test/items/${id}` };
      byId.set(id, work);
      bodies.set(id, item.body);
      created.push({ ...item, id });

      return work;
    },
    updateItemBody(id, body) {
      if (!byId.has(id)) throw new Error(`no such item ${id}`);
      bodies.set(id, body);
    },
  };
}
