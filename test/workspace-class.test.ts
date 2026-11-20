import { describe, expect, test } from "bun:test";
import type { PriorityClass } from "../src/check-priority";
import type { Provider } from "../src/pm/provider";
import { defaultCheckQueue, defaultConfig, type ProjectConfig } from "../src/project-config";
import { type ClaimContext, workspaceClass } from "../src/workspace-class";

const CLASSES: readonly PriorityClass[] = [
  { name: "high", icon: "🔺" },
  { name: "normal", icon: "🔹", default: true },
  { name: "low", icon: "🔻" },
];

/** A provider whose item id is the branch's second segment, such as `feat/TIP-3-x` giving `TIP-3`. */
// SAFETY: workspaceClass reaches the provider only through itemIdOf, which calls idFromBranch and nothing else
const make = (): Provider => ({ idFromBranch: (branch: string) => branch.split("/")[1]?.split("-").slice(0, 2).join("-") }) as Provider;

const configWith = (queue: Partial<ProjectConfig["checkQueue"]>): ProjectConfig => ({
  ...defaultConfig(),
  projectManagement: { name: "jira", project: "TIP" },
  checkQueue: { ...defaultCheckQueue(), classes: CLASSES, ...queue },
});

const claim = (queue: Partial<ProjectConfig["checkQueue"]>, branch: string): ClaimContext => ({ config: configWith(queue), dir: "/nowhere", branch });

describe("workspaceClass", () => {
  test("takes the highest class across claims, with item rules resolved from the branch", () => {
    const lowRepo = claim({ priority: "low" }, "chore/ENG-1-x");
    const tipRepo = claim({ priorityRules: [{ priority: "high", item: "^TIP-" }] }, "feat/TIP-3-x");
    expect(workspaceClass([lowRepo, tipRepo], make)).toEqual({ name: "high", rank: 0, icon: "🔺" });
  });

  test("a claim no rule or repo priority names gets the default class", () => {
    expect(workspaceClass([claim({}, "feat/ENG-2-y")], make)?.name).toBe("normal");
  });

  test("no claims, no class", () => {
    expect(workspaceClass([], make)).toBeUndefined();
  });

  test("a type or label rule reads the claim's item facts by repo and item id", () => {
    const rules = { priorityRules: [{ priority: "low", label: "^tech-debt$" }, { priority: "high", type: "^Story$" }] };
    const story = { ...claim(rules, "feat/ENG-2-y"), repo: "web" };
    const asked: string[] = [];

    const factsOf = (repo: string, item: string) => {
      asked.push(`${repo} ${item}`);

      return item === "ENG-2" ? { type: "Story", labels: [] } : undefined;
    };

    expect(workspaceClass([story], make, factsOf)?.name).toBe("high");
    expect(workspaceClass([{ ...claim(rules, "feat/ENG-3-z"), repo: "web" }], make, factsOf)?.name).toBe("normal");
    expect(asked).toEqual(["web ENG-2", "web ENG-3"]);
  });

  test("rules without type or label never read item facts", () => {
    const factsOf = () => {
      throw new Error("read item facts");
    };

    expect(workspaceClass([{ ...claim({ priorityRules: [{ priority: "high", item: "^ENG-" }] }, "feat/ENG-2-y"), repo: "web" }], make, factsOf)?.name).toBe("high");
  });
});
