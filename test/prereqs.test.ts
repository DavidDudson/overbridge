import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "../src/paths";
import { requiredSkillProblems } from "../src/plugins";

const tmp = mkdtempSync(join(tmpdir(), "overbridge-prereqs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function skillsDir(name: string, skills: string[]): string {
  const dir = join(tmp, name);
  for (const s of skills) {
    mkdirSync(join(dir, s), { recursive: true });
    writeFileSync(join(dir, s, "SKILL.md"), `---\nname: ${s}\n---\n`);
  }
  return dir;
}

describe("requiredSkillProblems", () => {
  test("none when a skills folder holds the skill", () => {
    expect(requiredSkillProblems(["gh-stack"], [skillsDir("present", ["gh-stack"])])).toEqual([]);
  });

  test("finds the skill in any of the folders", () => {
    const dirs = [skillsDir("empty", []), skillsDir("plugin", ["gh-stack"])];
    expect(requiredSkillProblems(["gh-stack"], dirs)).toEqual([]);
  });

  test("names each missing skill", () => {
    const problems = requiredSkillProblems(["gh-stack", "other"], [skillsDir("one", ["other"])]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("'gh-stack' skill is not installed");
  });
});

describe("skill frontmatter", () => {
  const skills = ["plugin", "plugin-review"].flatMap((plugin) =>
    readdirSync(join(packageRoot(), plugin, "skills")).map((name) => join(packageRoot(), plugin, "skills", name, "SKILL.md")),
  );

  test("every skill that runs gh stack declares requires: gh-stack", () => {
    const undeclared = skills.filter((file) => {
      const text = readFileSync(file, "utf8");
      const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
      return /gh[ -]stack/.test(text) && !/^requires:.*\bgh-stack\b/m.test(front);
    });
    expect(undeclared).toEqual([]);
  });
});
