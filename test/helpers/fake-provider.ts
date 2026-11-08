import type { Provider, WorkItem } from "../../src/pm/provider";
import { slug } from "../../src/pm/provider";

/** In-memory provider for tests. `calls` counts `title` fetches. */
export function fakeProvider(items: WorkItem[] = [], name: "github" | "jira" = "github"): Provider & { calls: number } {
  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    name,
    calls: 0,
    idFromBranch: (branch) => /(?:^|\/)([A-Z]+-\d+|\d+)(?:-|$)/.exec(branch)?.[1],
    link: (id) => `https://fake.test/items/${id}`,
    title(id) {
      this.calls++;
      return byId.get(id)?.title;
    },
    assigned: () => items,
    branchName: (item) => `feat/${item.id}-${slug(item.title)}`,
  };
}
