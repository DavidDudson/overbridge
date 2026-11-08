import { describe, expect, test } from "bun:test";
import { runItem } from "../src/item";
import type { ProjectManagement } from "../src/project-config";
import { fakeProvider } from "./helpers/fake-provider";

const pm: ProjectManagement = { name: "github", project: "o/r", techDebt: "42" };
const items = [{ id: "12", title: "Add dark mode!", url: "https://fake.test/items/12" }];
const run = (p: ReturnType<typeof fakeProvider>, ...argv: string[]) => runItem(p, pm, argv, () => "feat/12-dark-mode");

describe("overbridge item", () => {
  test("view prints id, title and url", () => {
    expect(JSON.parse(run(fakeProvider(items), "view", "12")!)).toEqual(items[0]);
  });

  test("view of an unknown item fails", () => {
    expect(() => run(fakeProvider(items), "view", "99")).toThrow("99: not found");
  });

  test("from-branch reads the argument, else the current branch", () => {
    const p = fakeProvider(items);
    expect(run(p, "from-branch", "feat/7-x")).toBe("7");
    expect(run(p, "from-branch")).toBe("12");
    expect(() => run(p, "from-branch", "main")).toThrow("no github item in branch 'main'");
  });

  test("branch uses the fetched title or --title", () => {
    const p = fakeProvider(items);
    expect(run(p, "branch", "12")).toBe("feat/12-add-dark-mode");
    expect(run(p, "branch", "13", "--title", "Fix it")).toBe("feat/13-fix-it");
    expect(() => run(p, "branch", "99")).toThrow("not found; pass --title");
  });

  test("assigned lists items as JSON", () => {
    expect(JSON.parse(run(fakeProvider(items), "assigned")!)).toEqual(items);
  });

  test("create passes labels and parent through", () => {
    const p = fakeProvider();
    const out = JSON.parse(run(p, "create", "--title", "T", "--body", "B", "--label", "a", "--label", "b", "--parent", "5")!);
    expect(out.id).toBe("1000");
    expect(p.created[0]).toMatchObject({ title: "T", body: "B", labels: ["a", "b"], parent: "5" });
  });

  test("create --tech-debt files under the configured container", () => {
    const p = fakeProvider();
    run(p, "create", "--title", "T", "--body", "B", "--tech-debt");
    expect(p.created[0]!.parent).toBe("42");
  });

  test("create needs a title and a body", () => {
    expect(() => run(fakeProvider(), "create", "--body", "B")).toThrow("--title is required");
    expect(() => run(fakeProvider(), "create", "--title", "T")).toThrow("pass --body or --body-file");
  });

  test("edit replaces the body and prints nothing", () => {
    const p = fakeProvider(items);
    expect(run(p, "edit", "12", "--body", "new")).toBeUndefined();
    expect(p.bodies.get("12")).toBe("new");
  });

  test("an unknown action prints the usage", () => {
    expect(() => run(fakeProvider(), "nope")).toThrow("usage: overbridge item");
  });
});
