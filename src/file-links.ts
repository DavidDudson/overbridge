/** The editors `ide` names; `none` means no editor link, only the GitHub permalink. */
export const IdeName = { VsCode: "vscode", Zed: "zed", WebStorm: "webstorm", None: "none" } as const;

export type IdeName = (typeof IdeName)[keyof typeof IdeName];

export const IDES: readonly IdeName[] = Object.values(IdeName);

/** The resolved `ide` key: `ide: zed` or `ide: { name, link?, github? }`. */
export interface IdeConfig {
  name: IdeName;
  /** Editor link template for a file reference: `link`, else the ide's default; unset for `none`. */
  link?: string;
  /** Add a GitHub permalink after the editor link. Default true. */
  github: boolean;
}

/** Placeholders an `ide.link` template may use. */
export const LINK_PLACEHOLDERS = ["path", "line", "relpath", "owner", "repo", "sha"] as const;

/** The editor link each ide gets when `ide.link` is unset; `none` has no editor link. */
export const DEFAULT_LINKS: Record<IdeName, string | undefined> = {
  [IdeName.Zed]: "zed://file/{path}:{line}",
  [IdeName.VsCode]: "vscode://file/{path}:{line}",
  [IdeName.WebStorm]: "webstorm://open?file={path}&line={line}",
  [IdeName.None]: undefined,
};

/** A commit-pinned GitHub permalink to one line. */
export const GITHUB_LINK = "https://github.com/{owner}/{repo}/blob/{sha}/{relpath}#L{line}";

/** Problems with an `ide.link` template: unknown placeholders, or no file in it. */
export function linkTemplateProblems(template: string): string[] {
  const used = [...template.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]!);
  const allowed: readonly string[] = LINK_PLACEHOLDERS;
  const unknown = used.flatMap((p) => (allowed.includes(p) ? [] : [`unknown placeholder {${p}} (allowed: ${LINK_PLACEHOLDERS.map((a) => `{${a}}`).join(", ")})`]));
  const noFile = used.includes("path") || used.includes("relpath") ? [] : ["needs {path} or {relpath}, so the link names a file"];

  return [...unknown, ...noFile];
}

/** `template` with every placeholder in `values` filled in; the rest stay as written. */
export const fillLink = (template: string, values: Partial<Record<string, string>>): string =>
  template.replace(/\{([a-z]+)\}/g, (whole, key: string) => values[key] ?? whole);

const EXAMPLE = { path: "/abs/path/to/repo/AGENTS.md", relpath: "AGENTS.md", line: "268", owner: "<owner>", repo: "<repo>", sha: "<sha>" };

/**
 * The brief's "File references" section: how an agent writes a file:line reference as a markdown link, from
 * the resolved `ide` config. Unset behaves as `none`: the GitHub permalink is the only link.
 */
export function fileLinkSection(ide: IdeConfig | undefined): string {
  const editor = ide?.link;
  const github = editor === undefined || ide?.github !== false;
  const main = editor ?? GITHUB_LINK;
  const label = `${EXAMPLE.relpath}:${EXAMPLE.line}`;
  const example = `[${label}](${fillLink(main, EXAMPLE)})${editor !== undefined && github ? ` [↗](${fillLink(GITHUB_LINK, EXAMPLE)})` : ""}`;
  const usesGithub = github || /\{(owner|repo|sha)\}/.test(main);

  const lines: string[] = [
    "",
    "## File references",
    "",
    "Write every file reference in your replies, plans and summaries as a markdown link the user can click, never as",
    "bare text. Give a line whenever the point is a spot in the file: label it `<file>:<line>`, or `<file>:<start>-<end>`",
    "for a range. A bare `<file>` label is only for the file as a whole (its links then use line 1). Like this:",
    "",
    example,
    "",
    `- ${editor !== undefined ? "Editor link" : "Link"}: \`${main}\`.`,
  ];

  if (editor !== undefined && github) {
    lines.push(`- After it, a space and \`[↗](${GITHUB_LINK})\`, which opens the line on GitHub.`);
  }

  lines.push(
    "- `{path}` is the absolute path, never a relative one; `{relpath}` is the path from the repo root; `{line}` is the line number.",
    `  For a range, \`{line}\` is its first line${usesGithub ? ", and the GitHub link ends \`#L<start>-L<end>\`" : ""}.`,
  );

  if (usesGithub) {
    lines.push(
      "- `{owner}` and `{repo}` come from `git remote get-url origin`; `{sha}` is `git rev-parse HEAD` in that repo, so the link",
      "  stays on the commit you read. It resolves on GitHub only once that commit is pushed. For a file outside a",
      "  GitHub repo, use its absolute path as the label and leave the GitHub link out.",
    );
  }

  return lines.join("\n") + "\n";
}
