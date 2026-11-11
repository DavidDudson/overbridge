import { describe, expect, test } from "bun:test";
import { parseProject, projectRows, rowsFromProject } from "../src/pm/board-github";
import { boardSources } from "../src/worklist-run";
import { parseConfig } from "../src/project-config";

const item = (n: number, status: string, over: Record<string, unknown> = {}) => ({
  status,
  labels: ["p1"],
  title: `t${n}`,
  content: { type: "Issue", number: n, repository: "o/pioneer", title: `t${n}`, url: `https://github.com/o/pioneer/issues/${n}` },
  ...over,
});
const json = JSON.stringify({
  items: [item(1, "Backlog"), item(2, "Ready"), item(3, "Done"), item(4, "Backlog", { content: { type: "Issue", number: 4, repository: "o/other" } }), item(5, "Backlog", { content: { type: "PullRequest", number: 5, repository: "o/pioneer" } })],
});

describe("project backlog source", () => {
  test("keeps this repo's open issues, not done, PRs or other repos", () => {
    expect(rowsFromProject(json, "o/pioneer", "pioneer").map((r) => r.id)).toEqual(["1", "2"]);
  });
  test("statuses narrow it, without case", () => {
    expect(rowsFromProject(json, "o/pioneer", "pioneer", ["backlog"]).map((r) => r.id)).toEqual(["1"]);
  });
  test("parseProject", () => {
    expect(parseProject("DavidDudson/2", undefined)).toEqual({ owner: "DavidDudson", number: 2 });
    expect(parseProject("2", "o", ["Ready"])).toEqual({ owner: "o", number: 2, statuses: ["Ready"] });
    expect(parseProject("x", "o")).toBeUndefined();
    expect(parseProject("2", undefined)).toBeUndefined();
  });
  test("failed gh names the scope fix", () => {
    expect(() => projectRows({ owner: "o", number: 2 }, "o/pioneer", "pioneer", () => ({ ok: false, code: 1, stdout: "", stderr: "missing scope" }))).toThrow("gh auth refresh -s project");
  });
  test("board source carries the project", () => {
    const { sources } = boardSources([{ repo: "pioneer", url: "git@github.com:o/pioneer.git", pm: { name: "github", project: "o/pioneer", worklistProject: "2", worklistStatuses: ["Backlog"] } }]);
    expect(sources).toEqual([{ kind: "github", repo: "pioneer", slug: "o/pioneer", project: { owner: "o", number: 2, statuses: ["Backlog"] } }]);
  });
  test("config reads and validates the keys", () => {
    const y = (extra: string) => `project-management:\n  name: github\n  project: o/pioneer\n${extra}`;
    const pm = parseConfig(y("  worklist-project: DavidDudson/2\n  worklist-statuses: [Backlog, Ready]\n")).projectManagement;
    expect(pm).toMatchObject({ worklistProject: "DavidDudson/2", worklistStatuses: ["Backlog", "Ready"] });
    expect(() => parseConfig(y("  worklist-project: nope\n"))).toThrow("worklist-project");
  });
});
