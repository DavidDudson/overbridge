---
name: update-library
description: Upgrade a dependency (or a batch of non-breaking dependency bumps) to a target version under a tracked tech-debt item, driven end to end to a PR. Resolve from/to versions, compile the changelog and a breaking-change table with "affects us" analysis, gather blog and migration links, carry out the mandatory breaking-change migrations, and make a judgment call on deprecations (apply the small ones, spin off follow-up tech-debt items for the large ones). Both the item body and the PR body follow the library-update template. Use when the user wants to bump or upgrade a library ("update X to vN", "upgrade the Y dependency", "bump Z", "update library", "bump X, Y and Z together"). Also run by audit-vulns for each item it plans.
---

# Update library

Upgrade one dependency, or a batch of them (see *Batch mode*), to a target version, as a tracked and shipped tech-debt change:

```
resolve versions → research changelog/breaking/deprecations → build template
  → loop-tech-debt (item body = template)
    → loop-item → implement upgrade + migrations → ship-pr (PR body = template)
```

This skill **delegates the lifecycle** to `loop-tech-debt`, which files the item and chains `loop-item` (start-item, plan gate, implement, ship-pr). It does not reimplement item creation, branching or PR mechanics. Its own job is the library-specific work: version research, the template, the code migration and the deprecation judgment call.

## Extensions

Extension files can add to this skill without changing it. At each step marked `ext: <phase>`, run
`overbridge ext update-library <phase>` before you do the step, and follow what it prints as well as this skill. Where
the two conflict, the extension wins. It prints nothing when there is no extension. Its phases: `create-item`, `prose`.

## Guard

```sh
echo $OVERBRIDGE_NAME
overbridge config check
```

Empty `OVERBRIDGE_NAME` → stop: run this from a Claude session inside an overbridge workspace. A failing `config check` → stop and say what is wrong.

## Arguments

Free text naming the **library** and, ideally, the **target version**. Examples: `update vue-router to 4.5`, `bump axios to latest`, `upgrade pydantic`.

If the library is missing, ask which one. If the target version is missing, default to **latest stable** and state that you did.

Two optional forms:

- **Several libraries** (`bump axios to 1.20.0, undici@6 to 6.28.0, dompurify to latest`): batch mode, below.
- **An existing item id** (`123`, `#123`, `ENG-123`), as `audit-vulns` passes for items it filed up front: read the libraries and versions from the item body, run Phases 1 to 3 to fill in whatever the body left out, update the item body with the result (`overbridge item edit <id> --body-file -`), and in Phase 4 invoke `loop-item` on that id instead of `loop-tech-debt`. Never file a second item for the same work.

## Find the ecosystem

Everything below says "the manifest", "the lockfile" and "the package manager". Work out which from the repo:

| Lockfile / manifest | Manager | Latest-version query | Dedupe / refresh |
| --- | --- | --- | --- |
| `pnpm-lock.yaml`, `package.json` | pnpm | `npm view <lib> version` | `pnpm dedupe`, `pnpm up -r --depth Infinity <pkg>` |
| `package-lock.json` | npm | `npm view <lib> version` | `npm dedupe`, `npm update <pkg>` |
| `yarn.lock` | yarn | `npm view <lib> version` | `yarn dedupe` (berry), `yarn up <pkg>` |
| `bun.lock` | bun | `npm view <lib> version` | `bun update <pkg>` |
| `Cargo.lock` | cargo | `cargo search <crate> --limit 1` | `cargo update -p <crate>` |
| `uv.lock`, `poetry.lock`, `requirements*.txt` | uv / poetry / pip | `pip index versions <pkg>` | `uv lock --upgrade-package <pkg>`, `poetry update <pkg>` |
| `go.mod` | go | `go list -m -versions <mod>` | `go get <mod>@<to>`, `go mod tidy` |
| `build.gradle*`, `libs.versions.toml`, `pom.xml` | gradle / maven | Maven Central search | edit the version, then `gradle dependencies` / `mvn dependency:tree` |

A monorepo can hold several. Say which one the library lives in. Use `overbridge config get commands.<x>` for the repo's own install, typecheck, lint, test and build commands (`commands.build`, `commands.test`, …). A key that is unset means the repo has none: say so rather than guessing.

Run every typecheck, lint, test, and build command through `overbridge check <repo> -- <command>`: the check queue runs them in order across workspaces, several at once while the load allows, in the repo's dev shell. Run install and package-manager commands through `overbridge shell <repo> -- <command>`, which uses the same dev shell without queueing. Both run the command as it is when the repo declares no `shell`.

## Batch mode: several libraries, one item, one PR

A batch is allowed only when **every** bump in it is non-breaking for us:

- the from→to gap stays inside one major (patch or minor; for `0.x`, inside one minor), **and**
- Phase 2 finds no breaking change marked "Affects us: Yes", and no deprecation you would apply now.

Run Phases 1 and 2 per library. Any library that fails the test above leaves the batch and gets its own run of this skill (its own item and PR); say which and why. If one library is left, it is a normal single run.

A batch uses one item, one branch, one PR and one filled `TEMPLATE.md` with the batch summary table at the top and one `###` block per library underneath (see the batch note in the template). ACs are per library (`**A.** axios resolves to 1.20.0`, …) plus one shared AC for "no behaviour change".

Transitive bumps belong in batches too. The fix is a lockfile refresh (when the parent's range already admits the fixed version, then confirm the lockfile resolves `<to>`) or, when a parent exact-pins it, a scoped override in the manager's override mechanism (`overrides`/`resolutions` in the manifest, `[patch]` in Cargo, a constraints file in pip). Prefer the refresh: an override is a pin someone has to remove later.

## Phase 1: Resolve from/to versions

- **From**: the version currently installed. Read it from the manifest **and** confirm the resolved version in the lockfile: a range in the manifest is not the installed version. Read both from the default branch, not from whatever branch the workspace happens to be on (an earlier item's branch may already have bumped it): `git fetch origin`, then `git show origin/<default>:<path>/<manifest>` and the same for the lockfile. Nothing is claimed here; that happens in Phase 4 via `loop-tech-debt` → `loop-item` → `start-item`.
- **To**: the user's target, or latest stable (the query in the table above; `npm view <lib> versions --json` for the full list).
- Note if the from→to gap crosses **multiple majors**: the changelog and breaking-change work must cover every major in between, not just the endpoints.

State both versions explicitly before continuing.

## Phase 2: Research (changelog, breaking changes, deprecations, links)

Gather the raw material for the template. Prefer authoritative sources, in order:

1. **Context7 MCP**, if installed (`resolve-library-id` → `query-docs`), for current library docs and migration guidance.
2. The library's **changelog and releases**: GitHub releases, the registry, the repo's `CHANGELOG.md`. Cover **every** release between from and to.
3. **WebSearch / WebFetch** for the official **blog announcement(s)** and **migration guide(s)** for each major crossed.

Extract:

- **Changelog**: notable changes between the two versions (features, fixes, breaking, deprecations). Group by version.
- **Breaking changes**: each one, and whether it **affects us**. Determine "affects us" by searching the repo for the affected API or pattern (the Explore agent with `model: "sonnet"`, or `rg`). A breaking change we don't touch is "No"; one we do is "Yes" with the callsites.
- **Deprecations**: anything newly deprecated (still works, scheduled for removal).
- **Links**: blog announcement URL(s) and migration-guide URL(s). Always include these when they exist.

## Phase 3: Build the template

Fill in `TEMPLATE.md` (in this skill's directory) with the Phase 1 and 2 findings. This single filled-in template is used **verbatim** as both:

- the **item body** passed to `loop-tech-debt`, and
- the **PR body's** dependency block passed to `ship-pr`.

Required sections (all present, even if a section is "None"):

- **Version**: `from` → `to`.
- **Changelog**: grouped list of changes between the versions.
- **Breaking changes**: a table: `Change | Affects us? | Notes / callsites`.
- **Deprecations**: highlighted list; for each, the recommended action (apply now or defer to a follow-up item).
- **Links**: blog announcements and migration guides.
- **Migration plan**: the mandatory breaking-change code changes, and the deprecation decisions (see Phase 5).
- **Acceptance criteria**: lettered (`**A.**`, `**B.**`), stable ids the PR's checklist keys off.

## Phase 4: File the item and start the lifecycle

`ext: create-item`: run `overbridge ext update-library create-item` first (how to file the item).

Given an existing item id: update its body with the filled template, then invoke **`loop-item`** with that id and skip the rest of this phase.

Otherwise invoke **`loop-tech-debt`** with the filled template as the problem description and item body. It files the item under the repo's tech-debt container (`project-management.tech-debt`), then drives `loop-item`. Because the template is already the full body, pass it as the item description rather than the usual minimal problem plus acceptance criteria, and tell `loop-tech-debt` to skip its Phase 1 investigation.

`loop-item` runs without a plan-approval stop: write the migration plan (Phase 5) as its plan and go on. Stop only for its scope gate (`SPLIT` or `CLARIFY`).

Stay in this workspace for related work (the `workspace` skill's affinity table). An upgrade that must land on top of another open upgrade (a bump that needs the previous major first) is a layer: `gh stack add` here, never a new workspace. Independent upgrades each get their own item and workspace.

## Phase 5: Implement (bump, migrate, judge deprecations)

During the implement phase:

1. **Bump the version** in every manifest that declares it, respecting the repo's single-version policy if it has one (a syncpack or `cargo deny` config, a shared version catalogue). Install with the repo's install command. If the registry is unreachable (timeout, `ERR_SOCKET_TIMEOUT`, `FetchError`), stop and ask the user to restore access (VPN, proxy, credentials). Do not retry.
2. **Tidy the dependency tree** (every run, single or batch). Do this after the install and before verifying, so the PR leaves the lockfile and the policy exceptions tidier than it found them:
   - **Dedupe.** Run the manager's dedupe (table above) and commit the lockfile change in this PR. A bump can strand an older copy of a shared transitive. If dedupe moves a direct dependency (it can, when a range already admits a newer version), name it in the PR's Dependencies block and cover it in step 5.
   - **Stale exceptions.** If the repo keeps policy exceptions (pnpm's `trustPolicyExclude` and `minimumReleaseAgeExclude`, npm `overrides`, yarn `resolutions`, cargo-deny skips, audit ignore lists), drop each that is no longer needed. Delete one, re-run the check that justified it (`pnpm dedupe --check` for trust exceptions, since a frozen install never re-resolves and never shows the error; the audit or resolver for the rest), and leave it deleted only if the check stays clean. An exception pinned to a version released more than three days ago is a candidate for removal under a release-age policy.

   Removing an exception only tightens policy, so it needs no approval. Adding one still does (see `audit-vulns`). List each removed entry in the PR's Dependencies block.
3. **Carry out every breaking-change migration that affects us**: these are mandatory. This is the minimum shippable change: after it, the project builds, typechecks and tests pass on the new version.
4. **Deprecations are a judgment call (optional):**
   - **Small, mechanical, localised** (few callsites, no behaviour change, no design decision): apply it now, in this PR.
   - **Large** (many callsites, behaviour change, or needs a design decision): **do not** balloon this PR. Recommend a **separate tech-debt item** per deprecation cluster, and record the recommendation in the template's Deprecations and Migration plan sections. Optionally file those items (`overbridge item create --tech-debt`) and link them. Do not start them from here while this PR is open unless the user asks: a follow-up that builds on this PR is a stacked layer in this workspace, anything else is its own workspace (`overbridge start <repo> <id>`). Leave a `// TODO(<item link>): migrate off <deprecated API>` at the callsites, naming the follow-up item.
   - State the reasoning for each apply-vs-defer decision in the template.
5. Verify with the **smallest** scope that proves it: the repo's `commands.typecheck`, then `commands.test` on the touched files or project only. Run the full suite once at the end.

The outcome is always: **the mandatory breaking-change-only code change ships**, plus whatever small deprecations you judged safe. Large deprecations become recommended or filed follow-up items, not scope creep.

## Phase 6: PR

`ship-pr` (via the lifecycle) opens the PR. Put the filled library-update template (heading demoted to `###`) in a collapsed **Dependencies** block of the PR description, in place of generic per-dependency detail. Carry the Migration plan's mandatory migrations into the visible summary bullets, and deferred deprecations into a **Deprecations** line and a follow-up item.

The item body stays the full library-update template.

## Report

One-line summary: library (or, for a batch, each library), from→to, the item as a link, the PR as a link, build status, and a count of deprecations applied vs deferred (with links to the follow-up items).

## Rules

- Delegate the lifecycle to `loop-tech-debt` / `loop-item` / `ship-pr`. Never reimplement start or PR logic. The item body is the library-update template; the PR body carries it in its collapsed Dependencies block.
- The **from and to versions are non-negotiable content**: always resolve the real installed version, never the manifest range.
- Cover **every major** between from and to, not just the endpoints.
- "Affects us" must be evidence-based: search the repo, don't guess.
- **Publish the verdict, not the route to it.** Each row states what changed and what it means for this repo. When a later phase overturns an earlier verdict, rewrite that row to the correct answer rather than narrating the correction: no "I first read this as types-only and was wrong", no "turned out to be". Same rule as code comments: no archaeology.
- **Keep it short enough to be read.** A reviewer needs the breaking-change table, the callsites and what shipped. Cut anything that only records how the work felt: no "worth flagging", no meta-commentary on what your own local checks did or did not catch, no changelog dump of unrelated minor-release features. If a fact would not change what a reviewer does, it does not belong in the body.
- Always include blog-announcement and migration-guide links when they exist.
- Breaking-change migrations that affect us are **mandatory**; deprecation migrations are **optional** and decided per cluster (apply small, defer large).
- Never let deprecation work bloat the upgrade PR: defer and recommend instead.
- Every run ends with a dedupe and drops the policy exceptions that no longer apply (Phase 5, step 2), so the tree never needs a dedupe item of its own.
- Respect `loop-item`'s scope gate (its only stop), and the registry-access rule for installs.

## Humanizer pass

`ext: prose`: run `overbridge ext update-library prose` first (passes over the text you publish).

If the `humanizer` skill is installed, run it over the item body and the PR description before publishing, and publish the result rather than your draft. This applies to edits as well as new text. After the write, read the text back (`gh issue view`, `jira issue view`, `gh pr view`) and confirm what landed matches what you sent. A write can silently drop a section.

Commit messages and code comments are exempt.
