import { type IdeConfig, IdeName } from "./ide";

/** Placeholders an `ide.link` template may use. */
export const LINK_PLACEHOLDERS = ["path", "line", "relpath", "owner", "repo", "sha"] as const;

export type LinkPlaceholder = (typeof LINK_PLACEHOLDERS)[number];

const isPlaceholder = (name: string): name is LinkPlaceholder => LINK_PLACEHOLDERS.some((p) => p === name);

/** The editor link each ide gets when `ide.link` is unset; `none` has no editor link. `{path}` already starts with `/`. */
export const DEFAULT_LINKS: Record<IdeName, string | undefined> = {
  [IdeName.Zed]: "zed://file{path}:{line}",
  [IdeName.VsCode]: "vscode://file{path}:{line}",
  [IdeName.WebStorm]: "webstorm://open?file={path}&line={line}",
  [IdeName.None]: undefined,
};

/** The config a bare ide name resolves to: its default link, and the GitHub link on. */
export const defaultIde = (name: IdeName): IdeConfig => {
  const link = DEFAULT_LINKS[name];

  return link === undefined ? { name, github: true } : { name, link, github: true };
};

/** A commit-pinned GitHub permalink to one line. */
export const GITHUB_LINK = "https://github.com/{owner}/{repo}/blob/{sha}/{relpath}#L{line}";

/** Problems with an `ide.link` template: unknown placeholders, or no file in it. */
export function linkTemplateProblems(template: string): string[] {
  const used = [...template.matchAll(/\{([^}]*)\}/g)].map(([, name = ""]) => name);
  const unknown = used.flatMap((p) => (isPlaceholder(p) ? [] : [`unknown placeholder {${p}} (allowed: ${LINK_PLACEHOLDERS.map((a) => `{${a}}`).join(", ")})`]));
  const noFile = used.includes("path") || used.includes("relpath") ? [] : ["needs {path} or {relpath}, so the link names a file"];

  return [...unknown, ...noFile];
}

/** `template` with every placeholder in `values` filled in; the rest stay as written. */
export const fillLink = (template: string, values: Partial<Record<LinkPlaceholder, string>>): string =>
  template.replace(/\{([a-z]+)\}/g, (whole, key: string) => (isPlaceholder(key) ? values[key] : undefined) ?? whole);

const EXAMPLE: Record<LinkPlaceholder, string> = { path: "/abs/path/to/repo/AGENTS.md", relpath: "AGENTS.md", line: "268", owner: "<owner>", repo: "<repo>", sha: "<sha>" };

/**
 * The brief's "File references" section: how an agent writes a file:line reference as a markdown link, from
 * the resolved `ide` config. Empty when `ide` is unset, or is `none` with `github: false`: there is no link to write.
 */
export function fileLinkSection(ide: IdeConfig | undefined): string {
  if (ide === undefined || (ide.link === undefined && !ide.github)) {
    return "";
  }

  const main = ide.link ?? GITHUB_LINK;
  const arrow = ide.link !== undefined && ide.github;
  const usesGithub = main === GITHUB_LINK || arrow || /\{(owner|repo|sha)\}/.test(main);
  const example = `[${EXAMPLE.relpath}:${EXAMPLE.line}](${fillLink(main, EXAMPLE)})${arrow ? ` [↗](${fillLink(GITHUB_LINK, EXAMPLE)})` : ""}`;

  const lines = [
    "",
    "## File references",
    "",
    "Write every file reference in your replies, plans and summaries as a markdown link the user can click, never as",
    "bare text. Give a line whenever the point is a spot in the file: label it `<file>:<line>`, or `<file>:<start>-<end>`",
    "for a range. A bare `<file>` label is only for the file as a whole (its links then use line 1). In a link target,",
    "write a space as `%20` and parentheses as `%28` and `%29`, so the link does not break. Like this:",
    "",
    example,
    "",
    `- ${ide.link === undefined ? "Link" : "Editor link"}: \`${main}\`.`,
    ...(arrow ? [`- After it, a space and \`[↗](${GITHUB_LINK})\`, which opens the line on GitHub.`] : []),
    "- `{path}` is the absolute path, never a relative one; `{relpath}` is the path from the repo root; `{line}` is the line number.",
    `  For a range, \`{line}\` is its first line${usesGithub ? ", and the GitHub link ends \`#L<start>-L<end>\`" : ""}.`,
    ...(usesGithub
      ? [
          "- `{owner}` and `{repo}` come from `git remote get-url origin`; `{sha}` is `git rev-parse HEAD` in that repo, so the link",
          "  stays on the commit you read. It resolves on GitHub only once that commit is pushed. For a file outside a",
          "  GitHub repo, use its absolute path as the label and leave the GitHub link out.",
        ]
      : []),
  ];

  return lines.join("\n") + "\n";
}
