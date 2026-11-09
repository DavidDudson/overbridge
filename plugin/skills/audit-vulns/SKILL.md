---
name: audit-vulns
description: Audit the open security vulnerabilities in a GitHub repo (Dependabot alerts, cross-checked with the ecosystem's own audit command), work out the cheapest fix for each vulnerable package, and report a plan of N items sized by risk. Non-breaking patch and minor bumps (direct or transitive) go together in one batch item; each breaking upgrade gets its own item and PR. After the user approves the plan, files the items and drives each one through update-library → loop-tech-debt / loop-item. Use when the user says "audit vulns", "audit the security vulnerabilities", "what CVEs can we fix quickly", "dependabot quick wins", "clear the dependabot alerts", "audit-vulns", or wants a plan to bring the repo's open advisories down.
---

# Audit vulns

Turn the open advisories into a short, ordered set of upgrade items:

```
collect alerts → group by package → resolve fix route per package → classify (batch / own item / no fix)
  → report + proposed items  [STOP: user approves]
    → file items → update-library <id> (first one here, the rest in other workspaces)
```

This skill decides **what** to upgrade and **how to split it**. The upgrade itself, the item body and the PR belong to `update-library` (which runs `loop-tech-debt` / `loop-item`). Do not reimplement any of that.

## Extensions

Extension files can add to this skill without changing it. At each step marked `ext: <phase>`, run
`overbridge ext audit-vulns <phase>` before you do the step, and follow what it prints as well as this skill. Where
the two conflict, the extension wins. It prints nothing when there is no extension. Its phases: `create-item`, `prose`.

## Guard: only inside a workspace

```sh
echo $OVERBRIDGE_NAME
overbridge config check
overbridge config get project-management.name
gh repo view --json nameWithOwner -q .nameWithOwner
```

Empty `OVERBRIDGE_NAME` → stop and say `audit-vulns` must run from a session inside an overbridge workspace. The audit itself only reads, but the items it ends in need a workspace.

No `project-management` in `overbridge.yml` → the audit can run, but nothing can be filed. Say so up front.

`gh repo view` fails (not a GitHub repo, no auth) → Dependabot alerts are unavailable. Fall back to the ecosystem audit alone (Phase 1, step 2) and say the plan is less complete.

Below, `<owner>/<repo>` is the `nameWithOwner` that command printed, and `<default>` is the repo's default branch.

## Arguments

Optional filters, free text: a minimum severity (`high+`), a scope (`runtime only`, `dev only`), or packages to include or skip. Default: every open alert, all severities, both scopes.

## Phase 1: Collect

Read everything from `origin/<default>`, never from the workspace's current branch. Run `git fetch origin`, then `git show origin/<default>:<path>`; don't touch the working tree.

1. **Dependabot alerts** are the source of truth. They carry scope, relationship and manifest path:

   ```sh
   gh api --paginate 'repos/<owner>/<repo>/dependabot/alerts?state=open&per_page=100' \
     --jq '.[] | {n: .number, url: .html_url, pkg: .dependency.package.name,
                  scope: .dependency.scope, rel: .dependency.relationship,
                  manifest: .dependency.manifest_path,
                  sev: .security_advisory.severity, ghsa: .security_advisory.ghsa_id,
                  summary: .security_advisory.summary,
                  range: .security_vulnerability.vulnerable_version_range,
                  fixed: .security_vulnerability.first_patched_version.identifier}'
   ```

   Save the output to the scratchpad; it is the input for every later phase. A 403 or 404 usually means Dependabot alerts are off for the repo or the token lacks access: say so, don't guess.
2. **The ecosystem's audit command** as a cross-check, when dependencies are installed: run through `overbridge shell <repo> -- <cmd>` so it sees the repo's dev shell: `pnpm audit` / `npm audit` / `yarn npm audit`, `cargo audit`, `pip-audit`, `osv-scanner`. Report anything it finds that Dependabot doesn't; don't block on it. If it needs registry access and times out, stop and ask the user to restore it; don't retry.
3. **Open Dependabot PRs**: `gh pr list -R <owner>/<repo> --author app/dependabot --state open --json number,title,url`. A package that already has one is either merged as is (when it is green and covers every manifest) or folded into an item here and the Dependabot PR closed with a link to ours. Say which.

## Phase 2: Group and resolve the fix route

Group alerts by **package + major line** (`axios@1`, `brace-expansion@2`): one row per group, many alerts and manifests per row. For each group:

- **Installed version(s)**: from the lockfile on `origin/<default>`, not the manifest range.
- **Target**: the lowest version that clears **every** open alert in the group (the max of their `fixed` values), then the latest patch on that line if it is older than the repo's release-age policy requires (check the repo's config: pnpm `minimumReleaseAge`, a Renovate `minimumReleaseAge`; `npm view <pkg> time --json` shows publish dates). Never add a release-age exclusion to get round the policy without asking.
- **Fix route**, first match wins:

| Situation | Route | Breaking? |
| --- | --- | --- |
| Direct dep, target inside the declared major | bump in every manifest that declares it (respecting any single-version policy) | no |
| Transitive, parent's range already admits the target | lockfile refresh, then confirm the lockfile resolves the target (`pnpm up -r --depth Infinity <pkg>`, `npm update <pkg>`, `cargo update -p <crate>`, `uv lock --upgrade-package <pkg>`) | no |
| Transitive, a parent exact-pins it, target inside the same major | override scoped to the major (`<pkg>@<major>: <target>` in pnpm `overrides`, yarn `resolutions`, npm `overrides`) | no |
| Transitive, a newer **parent** release drops the vulnerable range | bump the parent (`pnpm why -r <pkg>`, `npm explain <pkg>`, `cargo tree -i <crate>` names it); classify the parent's own from→to | depends on parent |
| Target is a new major (direct, or parent must cross a major) | upgrade across the major | yes |
| `fixed` is empty, or the only fixed line is out of reach | no fix available | n/a |

  Check the existing overrides block first: an existing pin for the package may itself be what holds it on the vulnerable version.
- **Breaking?** for the "no" rows is a claim that needs evidence before it goes in the batch: skim the releases between installed and target (`gh release list` / changelog) for anything marked breaking. A minor that breaks something we use moves to its own item. `update-library` re-checks this properly; this pass only stops obvious mis-sorts.
- **Reach**: runtime (`scope: runtime` in any manifest of a shipped app or library) or dev-only. Runtime outranks dev at the same severity.

## Phase 3: Plan the items

Sort the groups into items. Risk sets the item count:

1. **Batch item: quick wins.** Every group whose route is non-breaking. One item and one PR, using `update-library` batch mode. Split into a **runtime** batch and a **dev** batch when the combined batch passes about 10 packages, so a failing dev-tool bump can't hold back a runtime fix (the same split a grouped Dependabot config uses).
2. **One item per breaking upgrade.** Packages that must move together (a framework and its plugins, a parent and the child it fixes) share one item. Order these by worst severity, then reach.
3. **No fix available**: no item by default. List each with the reason and the exposure (is the vulnerable code path reachable from shipped code?). Propose an item only when there is something to do: replace the package, remove it, or a parent upgrade that would clear it.

If everything is non-breaking, the plan is one item. Don't split a safe batch to look thorough, and don't fold a major into it to keep the count down.

## Phase 4: Report and stop

Print the report in chat:

1. **Headline**: open alerts by severity, runtime versus dev, how many the plan clears, and how many it leaves.
2. **Proposed items**, in the order they should land. For each: title, packages with from → to and route, alerts cleared (count and worst severity, linking each Dependabot alert URL), and a size note. For example:

   | # | Item | Packages | Clears | Breaking? |
   | --- | --- | --- | --- | --- |
   | 1 | Patch runtime deps with open advisories | `axios` 1.18.0 → 1.20.0 (bump), `dompurify` … (bump), `undici@6` … (override) | 85 alerts, 31 high | No |
   | 2 | Upgrade `vite` 6 → 7 | `vite`, `@vitejs/*` | 4 alerts, 2 high | Yes: `<one-line reason>` |

3. **Not fixed by this plan**: the no-fix groups and anything the user's filters skipped, with links.
4. **Existing Dependabot PRs**: each with its link and what happens to it.

Then **stop and ask** which items to go ahead with (AskUserQuestion, multi-select). Nothing is filed or changed before that answer.

## Phase 5: File and run

`ext: create-item`: run `overbridge ext audit-vulns create-item` first (how to file the items).

For each approved item:

1. File it with `overbridge item create --tech-debt --title "<title>" --body-file -`. The body is `update-library`'s `TEMPLATE.md` (batch form for the batch item) filled from this audit: packages, versions, routes, advisories fixed. Leave the changelog and breaking-change sections for `update-library` to complete. Run the humanizer pass first if the `humanizer` skill is installed, and read the body back after (`gh issue view` / `jira issue view`).
2. Report every item id as a link.

Then run the **first** item in this workspace: invoke `update-library` with its id. That skips item creation and goes through `loop-item`, plan gate included.

The rest can't run here: a workspace holds one branch per repo, and once item 1 has an open PR it is occupied. Give the user one prompt per remaining item to paste into Claude in another workspace (`/update-library <id>`). `overbridge status --all` shows which workspaces are free. Don't claim another workspace from here.

## Rules

- Dependabot alerts are the source of truth, read from GitHub; versions come from `origin/<default>`'s lockfile.
- Group by package and major line; one target per group that clears all of its alerts.
- Non-breaking bumps batch together; anything that crosses a major or breaks something we use gets its own item. The item count follows from that.
- Prefer a lockfile refresh over an override, and an override scoped to a major over a bare one.
- Respect the repo's supply-chain policy (release-age, trust, install-script allowlists). Don't loosen any of it to land a fix without asking.
- Don't plan a separate dedupe or exception-cleanup item. `update-library` runs the dedupe and drops stale exceptions on every item (its Phase 5, step 2), and the batch item's ACs include that step.
- Installs and audits may need registry access. On a timeout, stop and ask the user to restore it; don't retry.
- Stop for approval after the report. Never file items or edit files before it.
- Link every alert, PR and item you name.

## Humanizer pass

`ext: prose`: run `overbridge ext audit-vulns prose` first (passes over the text you publish).

If the `humanizer` skill is installed, run it over every item body this skill writes and publish the result rather than your draft. After the write, read the body back and confirm what landed matches what you sent. The chat report is exempt.
