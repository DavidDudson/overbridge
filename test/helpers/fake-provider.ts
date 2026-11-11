import type { NewItem, Provider, WorkItem } from "../../src/pm/provider";
import { ItemStatus, slug } from "../../src/pm/provider";

export type FakeCreated = NewItem & { id: string };

/** In-memory provider for tests. `calls` counts `title` fetches; `created` records `createItem` calls. */
export function fakeProvider(
  items: WorkItem[] = [],
  name: "github" | "jira" = "github",
  done: readonly string[] = [],
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
