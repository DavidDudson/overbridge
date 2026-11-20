import { describe, expect, test } from "bun:test";
import type { PriorityClass } from "../src/check-priority";
import type { WorkRow } from "../src/pm/worklist";
import { type CheckQueue, defaultCheckQueue } from "../src/project-config";
import { cachedFacts, rowClass } from "../src/worklist-class";

const CLASSES: readonly PriorityClass[] = [
  { name: "feature", icon: "🚀" },
  { name: "tip", icon: "💡" },
  { name: "normal", icon: "🔹", default: true },
  { name: "tech-debt", icon: "🧹" },
];

const queue = (o: Partial<CheckQueue> = {}): CheckQueue => ({
  ...defaultCheckQueue(),
  classes: CLASSES,
  priorityRules: [
    { priority: "feature", type: "^Story$" },
    { priority: "tip", item: "^TIP-" },
    { priority: "tech-debt", label: "^tech-debt$" },
    { priority: "tech-debt", branch: "^chore/" },
  ],
  ...o,
});

const row = (id: string, o: Partial<WorkRow> = {}): WorkRow => ({ repo: "ENG", repos: ["web"], id, title: id, url: "", status: "todo", labels: [], blockedBy: [], updatedAt: "", ...o });

describe("rowClass", () => {
  const classOf = rowClass((repo) => (repo === "web" ? queue() : undefined));

  test("matches type, item id and label; an unmatched row gets the default class", () => {
    expect(classOf(row("ENG-1", { type: "Story" }))?.name).toBe("feature");
    expect(classOf(row("TIP-2", { type: "Task" }))?.name).toBe("tip");
    expect(classOf(row("ENG-3", { type: "Task", labels: ["frontend", "tech-debt"] }))?.name).toBe("tech-debt");
    expect(classOf(row("ENG-4", { type: "Bug" }))).toEqual({ name: "normal", rank: 2, icon: "🔹" });
  });

  test("a row has no branch, so a branch rule never matches it", () => {
    const branchOnly = rowClass(() => queue({ priorityRules: [{ priority: "tech-debt", branch: "." }] }));
    expect(branchOnly(row("ENG-5"))?.name).toBe("normal");
  });

  test("takes the highest class across the row's repos, and none when no repo is known", () => {
    const perRepo = rowClass((repo) => (repo === "api" ? queue({ priority: "tip", priorityRules: [] }) : queue({ priority: "tech-debt", priorityRules: [] })));
    expect(perRepo(row("ENG-6", { repos: ["web", "api"] }))?.name).toBe("tip");
    expect(classOf(row("ENG-7", { repos: ["other"] }))).toBeUndefined();
  });
});

describe("cachedFacts", () => {
  test("finds a row by id within the claim's repo", () => {
    const rows = [row("ENG-1", { type: "Story", labels: ["x"] }), row("7", { repo: "api", repos: undefined, type: "Bug" })];
    expect(cachedFacts(rows, "web", "ENG-1")).toEqual({ item: "ENG-1", type: "Story", labels: ["x"] });
    expect(cachedFacts(rows, "api", "7")?.type).toBe("Bug");
    expect(cachedFacts(rows, "web", "7")).toBeUndefined();
  });
});
