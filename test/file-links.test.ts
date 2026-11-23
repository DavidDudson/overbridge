import { describe, expect, test } from "bun:test";
import { DEFAULT_LINKS, fileLinkSection, fillLink, GITHUB_LINK, IdeName, linkTemplateProblems } from "../src/file-links";
import { parseConfig } from "../src/project-config";

const ideOf = (yaml: string) => parseConfig(yaml, "f.yml").ide;

describe("ide config", () => {
  test("a bare name gets its default link and the GitHub link", () => {
    expect(ideOf("ide: zed\n")).toEqual({ name: IdeName.Zed, link: "zed://file/{path}:{line}", github: true });
    expect(ideOf("ide: vscode\n")).toEqual({ name: IdeName.VsCode, link: "vscode://file/{path}:{line}", github: true });
    expect(ideOf("ide: none\n")).toEqual({ name: IdeName.None, github: true });
  });

  test("the mapping form sets its own link and can turn the GitHub link off", () => {
    expect(ideOf('ide:\n  name: zed\n  link: "zed://file/{path}:{line}:1"\n  github: false\n')).toEqual({
      name: IdeName.Zed,
      link: "zed://file/{path}:{line}:1",
      github: false,
    });
    expect(ideOf("ide: { name: vscode }\n")).toEqual({ name: IdeName.VsCode, link: DEFAULT_LINKS[IdeName.VsCode], github: true });
  });

  test("leaving ide out leaves it unset", () => {
    expect(ideOf("version: 1\n")).toBeUndefined();
  });
});

describe("linkTemplateProblems", () => {
  test("every default and the GitHub link are valid", () => {
    for (const link of [...Object.values(DEFAULT_LINKS).filter((l) => l !== undefined), GITHUB_LINK]) {
      expect(linkTemplateProblems(link)).toEqual([]);
    }
  });

  test("an unknown placeholder and a link with no file are reported", () => {
    expect(linkTemplateProblems("x://{file}:{line}")).toEqual([
      "unknown placeholder {file} (allowed: {path}, {line}, {relpath}, {owner}, {repo}, {sha})",
      "needs {path} or {relpath}, so the link names a file",
    ]);
    expect(linkTemplateProblems("x://{relpath}")).toEqual([]);
  });
});

describe("fillLink", () => {
  test("fills the placeholders it is given and keeps the rest", () => {
    expect(fillLink(GITHUB_LINK, { owner: "o", repo: "r", relpath: "a/b.ts", line: "3" })).toBe("https://github.com/o/r/blob/{sha}/a/b.ts#L3");
  });
});

describe("fileLinkSection", () => {
  test("zed with GitHub: the editor link, then the arrow to the permalink", () => {
    const section = fileLinkSection(ideOf("ide: zed\n"));
    expect(section).toContain("## File references");
    expect(section).toContain("[AGENTS.md:268](zed://file//abs/path/to/repo/AGENTS.md:268) [↗](https://github.com/<owner>/<repo>/blob/<sha>/AGENTS.md#L268)");
    expect(section).toContain("absolute path");
    expect(section).toContain("git rev-parse HEAD");
    expect(section).toContain("#L<start>-L<end>");
    expect(section).toContain("<file>:<start>-<end>");
  });

  test("github: false leaves the arrow and the GitHub steps out", () => {
    const section = fileLinkSection(ideOf("ide: { name: vscode, github: false }\n"));
    expect(section).toContain("[AGENTS.md:268](vscode://file//abs/path/to/repo/AGENTS.md:268)\n");
    expect(section).not.toContain("↗");
    expect(section).not.toContain("git rev-parse");
  });

  test("none, or no ide at all, links to the GitHub permalink alone", () => {
    for (const ide of [ideOf("ide: none\n"), undefined]) {
      const section = fileLinkSection(ide);
      expect(section).toContain("[AGENTS.md:268](https://github.com/<owner>/<repo>/blob/<sha>/AGENTS.md#L268)\n");
      expect(section).not.toContain("↗");
    }
  });

  test("a custom link that uses the GitHub placeholders keeps the GitHub steps", () => {
    const section = fileLinkSection(ideOf('ide: { name: zed, link: "https://gh.example/{owner}/{repo}/{sha}/{relpath}#{line}", github: false }\n'));
    expect(section).toContain("git remote get-url origin");
  });
});
