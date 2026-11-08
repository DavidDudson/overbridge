---
name: update-personas
description: Keep the persona-* reviewer skills accurate. Runs a structural lint over personas (frontmatter, guard matches the mob-review panel table, intact output contract, no lane overlap, every rule in exactly one severity tier, no dead references) and a version-rot check for any persona that pins library or language versions in its rules (compares the pinned version to what the repo actually has installed and to what has since shipped upstream). Works on the built-in overbridge-review personas and on repo-local personas under `review.local-dir`. Use when the user says "update personas", "refresh the personas", "the personas are stale", "lint the personas", "check the persona versions", or after a big dependency bump.
---

# update-personas: keep the review panel accurate

Personas rot in two ways: **version rot** (a persona recommends an API that is now legacy, or flags one that is now the default) and **structural drift** (a broken output contract, a lane that overlaps another, a guard that no longer matches the panel table).

## Where to edit

- **Repo-local personas** live under `review.local-dir` (`overbridge config get review.local-dir`, default `.overbridge/personas`). Edit them in the current repo.
- **Built-in personas** live in the overbridge repo under `plugin-review/skills/persona-*/`, and the panel that spawns them is `plugin-review/skills/mob-review/SKILL.md`. **Never edit the installed plugin copy**: it is overwritten on update. Work in a checkout of the overbridge repo (`overbridge checkout overbridge <branch>`; ask the user for the repo name if it isn't registered). Before editing, `git fetch origin main` and start a fresh branch from `origin/main`; stop and ask if the checkout has uncommitted work. Below, `$SKILL_DIR/..` means `plugin-review/skills/` in that checkout.

## Modes

Read the argument:

- *(none)* or `all`: run **Part A** (version rot) over every persona that pins versions, then **Part B** (structural lint) over every persona.
- `versions`: Part A only.
- `persona-<name>` or `<name>`: Part B for that persona only (and Part A if it pins versions).
- `local`: both parts over repo-local personas only.

## Rules that apply to every edit

- **Never change a persona's output contract.** The trailing `ReportFindings` block and the `{"persona": …}` JSON line must keep their exact shape: `mob-review` parses them.
- Keep the frontmatter fields (`name`, `description`, `disable-model-invocation: true` on every `persona-*`) and the section order: Guard → Scope → What you review → Out of lane → Severity → Output.
- **Adding** a rule is routine. **Removing** a rule, dropping a lane, or deleting a persona needs the user's OK first. State what you'd remove and why.
- Every rule must be checkable against a changed line in a diff. If you can't say what the reviewer greps for, don't add it.
- When a persona's `description`, guard, or existence changes, update the matching row in `mob-review/SKILL.md` in the same pass (built-ins only; a local persona has no row).

## Part A: version-rot refresh

Only personas that **pin versions** are in scope. Find them:

```sh
rg -n -i '\b(v|version )?[0-9]+\.[0-9]+(\.[0-9]+)?\b' <persona-dir>/SKILL.md <persona-dir>/references 2>/dev/null
```

A persona pins a version when a rule or reference header says "as of X 3.4", "stable since Y 5", "installed: Z 2.1", or recommends an API by the release that introduced it. A bare mention in an example doesn't count. No persona pins versions → say so and skip Part A.

The premise of a version-pinned rule is "you're on a modern version, use the modern API". That premise needs both numbers: what's **installed** and what's **current**.

### A1. Read the installed versions

Read them from the repo being reviewed, preferring resolved versions over ranges:

```sh
rg -N '"(<pkg>)":' package.json */package.json        # JS/TS
rg -N '<pkg>' pyproject.toml requirements*.txt uv.lock  # Python
rg -N '<pkg>' build.gradle* libs.versions.toml pom.xml  # JVM
cat .nvmrc .tool-versions rust-toolchain.toml 2>/dev/null
```

Use the lockfile when a range is ambiguous. Note any package whose workspaces disagree: tell the user, since that mismatch is a problem on its own.

### A2. Read the current upstream versions

Use the ecosystem's registry, not memory (`npm view <pkg> version`, `pip index versions <pkg>`, `cargo search <crate>`, Maven Central). For what *changed* between installed and latest, read the release notes or changelog (`npm view <pkg> repository.url` finds them), or the `context7` MCP if installed. The personas exist precisely because memory goes stale.

### A3. Reconcile each pinned persona or reference

| Drift | Fix |
|---|---|
| Header says an older version than installed | Update the header **and** re-read the rules under it: a rule justified by "stable since 3.4" may now be the plain default |
| An API the file calls "new/opt-in" is now the documented default | Promote it: raise the severity, reword from "prefer" to "use" |
| An API the file recommends is now deprecated or superseded | Replace it; move the old form to the flag-list |
| Installed version gained a stable API the file doesn't mention | Add a rule: recommended form, legacy form to flag, severity |
| A rule guards against something the installed version made impossible | Propose removal (needs user OK) |
| Latest upstream is a major ahead of installed | Do **not** write the new major's API in as a rule. Add it under a `## Not yet — installed is vN` note so the next bump has a checklist |

### A4. Sync `SKILL.md` to its references

If the persona keeps detail in `references/*.md`, its `SKILL.md` is the index and the references are the detail. They must not disagree: update any versions listed inline, check every bullet under "What you review" still has a backing section, and that severities match.

### A5. Report

Show a table: package | installed | latest | persona/reference updated? | rules added/changed/removed.

## Part B: structural lint (any persona)

For each persona in scope, verify and fix:

1. **Frontmatter**: `name` matches the directory; `disable-model-invocation: true` present; `description` names the lane, the trigger phrasings, and what it explicitly does *not* cover.
2. **Guard matches the panel.** The guard sentence in the persona and the Guard column in `mob-review/SKILL.md` must describe the same condition. Local personas have no panel row: check only that the guard is diff-signal based (changed lines or file types), not "always".
3. **Output contract intact**: both the `ReportFindings` paragraph and the exact JSON line, with the right `persona` name and `category` slug.
4. **No lane overlap.** For each rule, check no other persona claims it. If two do, the narrower one keeps it and the other gains an "Out of lane" line pointing at it. A local persona that shadows a built-in name replaces it on purpose: flag it to the user as a note, not a defect.
5. **Severity list covers every rule**: each rule appears in exactly one tier.
6. **Dead references**: a `references/` file nothing links to, or a link to a file that doesn't exist. An "Out of lane" line that names a persona which doesn't exist in the panel table or `review.local-dir`.
7. **Calibration backlog.** `mob-review` Step 7 proposes persona edits from real runs. If the user approved any and they were never applied, apply them now.
8. **Skill-level lint.** If the `persona-skills` reviewer is installed, run it over the changed persona files too. It catches dangling references, unset placeholders and contradictions between skills.

## Finish

Print one table (persona | changed? | what changed) and list anything you deliberately left for the user to decide (removals, version majors not yet installed, shadowed built-ins). Don't commit or open a PR unasked: leave the changes on the branch and offer to open a PR with `ship-pr`.
