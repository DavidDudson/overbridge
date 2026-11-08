<!--
  Library-update template. Fill every section from the Phase 1 and 2 research.
  The work item body is this template in full. The PR body embeds it (heading
  demoted to ###) in the Dependencies part of the PR description: see
  update-library SKILL.md Phase 6.
  Keep sections even when empty: write "None" rather than deleting.

  VOICE: describe the end state, not how you arrived at it. The reader wants
  what changed and why it matters to this repo, in as few words as carry it.
  Write "`copy` now takes `string | (() => Promise<string>)`, so the `Selection`
  at Foo.vue:33 was replaced with `selection.toString()`". A fact and its
  consequence.
  Never narrate your own investigation or revise a verdict in place. No "I first
  read this as types-only and was wrong", no "found by typecheck rather than the
  release notes", no "turned out to be", no "worth flagging", no "I expected X
  but Y". If an early verdict was wrong, publish the correct one and delete the
  wrong one; the draft's history is not content. Same rule as code comments: no
  archeology.
-->

## `<library>`: `<from>` → `<to>`

<!-- If the gap crosses multiple majors, say so and cover every major below. -->

### Changelog

<!-- Notable changes between the two versions, grouped by release, newest first. -->

- **v<x.y.z>**
  - …
- **v<x.y.z>**
  - …

### Breaking changes

| Change | Affects us? | Notes / callsites |
| ------ | ----------- | ----------------- |
| <what changed> | Yes / No | <evidence: file:line, or why it doesn't touch us> |

<!-- "Affects us?" must be evidence-based: search the repo, don't guess. -->

### Deprecations

<!-- Newly deprecated APIs (still work, scheduled for removal). Highlight each. -->

- ⚠️ **<deprecated API>** → **<replacement>**
  - **Decision:** apply now / defer to follow-up item
  - **Why:** <small+mechanical, or large/behaviour-change/needs-design>
  - **Follow-up:** <link to the item> (if deferred)

### Links

- **Blog announcement:** <url or None>
- **Migration guide:** <url or None>

### Migration plan

<!-- The mandatory breaking-change code changes that ship in this PR,
     plus the deprecation apply-vs-defer decisions and their reasoning. -->

- [ ] Bump `<library>` to `<to>` (everywhere it is declared, per the repo's single-version policy if it has one)
- [ ] <mandatory breaking-change migration: affects us>
- [ ] <small deprecation applied in this PR, if any>
- Deferred deprecations → follow-up tech-debt items: <links>

### Acceptance criteria

<!-- Lettered, stable ids. The PR's checklist keys off these. -->

- **A.** `<library>` resolves to `<to>` everywhere it is installed
- **B.** Every breaking change marked "Affects us" is migrated
  1. <one sub-AC per affected change, if more than one>
- **C.** Each deprecation is either migrated or tracked in a follow-up item
- **D.** No behaviour change for users <or: the intended change>

<!--
  BATCH MODE (several non-breaking bumps in one item/PR; SKILL.md § Batch mode).
  Replace the single heading above with this, then repeat the ### Changelog …
  ### Links blocks once per library, each under its own `### <library>` heading
  (sub-sections become ####). Migration plan and Acceptance criteria stay single,
  at the end, with one AC per library.

  ## Dependency batch: <n> non-breaking bumps

  | Library | From → To | Direct / transitive | Fix route | Advisories fixed |
  | ------- | --------- | ------------------- | --------- | ---------------- |
  | `axios` | 1.18.0 → 1.20.0 | direct | bump | GHSA-xxxx (high) |
  | `undici@6` | 6.27.0 → 6.28.0 | transitive | lockfile refresh / override | GHSA-yyyy (medium) |

  "Advisories fixed" is for security-driven bumps (audit-vulns); write "None" otherwise.
-->
