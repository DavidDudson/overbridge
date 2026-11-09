import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { root } from "./paths";
import { loadRootLayers } from "./project-config";
import { fail, run } from "./util";

/**
 * Skill extensions: Markdown files of extra instructions a skill reads at a named phase, so a team can
 * add to or override a skill without forking it. A file is `<dir>/<skill>/<phase>.md`; `<dir>/all/<phase>.md`
 * applies to every skill that has that phase.
 */
export const REPO_EXT_DIR = join(".overbridge", "ext");
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Where extensions live, least specific first: the root config's `skill-extensions` (absolute, `~/`, or
 * relative to the root), then the repo's `.overbridge/ext` when `repoDir` is given.
 */
export function extensionDirs(repoDir: string | undefined, dirs = loadRootLayers().skillExtensions, home = homedir()): string[] {
  const expand = (d: string) => (d === "~" || d.startsWith("~/") ? join(home, d.slice(1)) : isAbsolute(d) ? d : resolve(root(), d));
  return [...dirs.map(expand), ...(repoDir ? [join(repoDir, REPO_EXT_DIR)] : [])];
}

/** The extension files for `skill` at `phase`, in the order to read them: later ones win where they conflict. */
export function extensionFiles(skill: string, phase: string, dirs: string[]): string[] {
  if (!NAME_RE.test(skill)) fail(`invalid skill name '${skill}'`);
  if (!NAME_RE.test(phase)) fail(`invalid phase name '${phase}'`);
  const out: string[] = [];
  for (const dir of dirs) {
    for (const name of skill === "all" ? ["all"] : ["all", skill]) {
      const file = join(dir, name, `${phase}.md`);
      if (existsSync(file) && statSync(file).isFile()) out.push(file);
    }
  }
  return out;
}

/** Every extension file under `dirs`, as `{ skill, phase, file }`, in read order. */
export function allExtensions(dirs: string[]): { skill: string; phase: string; file: string }[] {
  const out: { skill: string; phase: string; file: string }[] = [];
  for (const dir of dirs) {
    let skills: string[];
    try {
      skills = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const skill of skills.filter((s) => NAME_RE.test(s))) {
      let files: string[];
      try {
        files = readdirSync(join(dir, skill)).sort();
      } catch {
        continue;
      }
      for (const f of files) {
        const phase = f.replace(/\.md$/, "");
        if (f.endsWith(".md") && NAME_RE.test(phase)) out.push({ skill, phase, file: join(dir, skill, f) });
      }
    }
  }
  return out;
}

/** The extension text for a phase: each file's content under a comment naming it, or "" when there are none. */
export function renderExtensions(files: string[]): string {
  return files.map((f) => `<!-- overbridge ext: ${f} -->\n${readFileSync(f, "utf8").trimEnd()}\n`).join("\n");
}

/**
 * `overbridge ext <skill> <phase>` prints the extension text for that phase (nothing when there is none);
 * `overbridge ext list` lists every extension file. The repo is the git root of the cwd, if any.
 */
export function extCommand(args: string[]) {
  const top = run(["git", "rev-parse", "--show-toplevel"]);
  const dirs = extensionDirs(top.ok && top.stdout ? top.stdout : undefined);
  const [first, phase] = args;
  if (first === "list") {
    for (const e of allExtensions(dirs)) console.log(`${e.skill} ${e.phase}\t${e.file}`);
    return;
  }
  if (!first || !phase) fail("usage: overbridge ext <skill> <phase> | overbridge ext list");
  const text = renderExtensions(extensionFiles(first, phase, dirs));
  if (text) process.stdout.write(text);
}
