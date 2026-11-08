# PR body template

Used for every PR in every repo instead of the repo's own `PULL_REQUEST_TEMPLATE.md`, unless the repo's `CLAUDE.md` says otherwise. Three visible items, the screenshots, then at most four collapsed blocks. Everything is `**Label:** value` lines, not headed sections. The body is a summary: the reviewer has the diff for the how.

## Body

````markdown
**Feature flag:** <`flag-key` (off in production, on in staging) | None>

**User-facing change:** <Yes | No>
- <what users see | behind `flag-key` | other reason>

**Functional change:** <Yes | No>
- <what changes, one bullet per change | refactor / tests / tooling / docs>

**Gaps:** <None | n>
- <what is untested, and why that is acceptable or the follow-up item>

**Performance:** <data size, the action timed and where it ends, runs per side, and the build on each side>

| Metric | Target | Before (median) | Before runs | After (median) | After runs |
| --- | --- | --- | --- | --- | --- |
| <metric> | <the item's number, or None> | <value> | <run 1 / run 2 / run 3> | <value> | <run 1 / run 2 / run 3> |

<one or two sentences: whether the targets were met, and if not, where the time goes>

| Before | After |
| --- | --- |
| ![<what it shows>](<url>) | ![<what it shows>](<url>) |

<details>
<summary>Acceptance criteria: <N> ACs, <All Tested | n tested manually (B, C)></summary>

| # | AC | Old behaviour | Implementation | Tested by |
| --- | --- | --- | --- | --- |
| A | <AC, verbatim from the item> | <what happened before this PR, or "None (new)"> | <where and how, one line> | <Unit / Integration / E2E / Manual>: `<test file>` › <test name> |
| A.1 | <sub-AC> | <…> | <…> | <…> |
| — | <behaviour no AC covers> | <…> | <…> | <…> |

</details>

<details>
<summary>Testing: <Unit & Integration & E2E | Manual | None></summary>

**Existing behaviour:** <how regressions are covered><br>
**Variations:** <dimensions and values; covered set and where; combinations left out and why>

- [ ] 🧪 Unit tests
- [ ] 🧩 Integration tests
- [ ] 🧑‍🔬 End-to-End tests
- [ ] 🙅 No tests necessary
- [ ] I have reviewed my own diff.

</details>

<details>
<summary>Related items</summary>

**Item:** [<id> <title>](<url>)<br>
**<Relationship>:** [<id> <title>](<url>). <How this PR relates.>

</details>

<details>
<summary>Dependencies: <added / removed / upgraded / downgraded></summary>

- [ ] ➕ Added new dependencies
- [ ] ➖ Removed dependencies
- [ ] 🔼 Upgraded dependencies
- [ ] 🔽 Downgraded dependencies

<per-dependency detail>

</details>
````

Closing keywords go on a line of their own at the very end of the body (`Closes #123` on GitHub). A Jira key goes in the PR title or the commit body instead, where the Jira integration picks it up.

## Filling rules

- **Summarise, don't restate the code.** No technical summary, file list or walkthrough of the diff. A reviewer reads the diff for that.
- **`**Label:** value` lines, not sections.** No `##` headings in the body. Lines in the same group end in `<br>` so GitHub keeps them on separate lines without spacing them out; groups are separated by a blank line.
- Every line should change a reviewer's decision, or it goes. Drop any label, and any collapsed block, that would be empty. The two optional visible labels (**Feature flag**, **Performance**) appear only when they apply.
- **Never name a personal tool, skill, agent or review panel in the body.** Write the outcome ("covered by `Foo.spec.ts`"), never the route ("per the X skill", "the panel found").
- Collapsed blocks: keep a blank line after `<summary>` and before `</details>`, or GitHub won't render the markdown inside. The `<summary>` carries the headline so a reader gets it without expanding.
- Strip every placeholder and `<…>` before publishing. Never leave an instruction comment in the body.

### The visible items

Always present, in this order. The change items are `Yes`/`No`, and Gaps is a count, each with bullets under it (no blank line between, so the list sits under its label).

- **Feature flag** (only when the diff adds or reads a flag): the flag key in backticks and its production and staging state, read from wherever the repo keeps them, not guessed. A flag this PR introduces is "new, off everywhere". No flag → drop the label.
- **User-facing change:** whether users see anything the moment this merges, then one bullet saying what or why not.
  - `Yes` → what they see.
  - `No` → `behind \`flag-key\`` when the flag is off in production, or the reason users can't reach it yet (a route nothing links to, a backend change that hasn't deployed). Non-functional PRs: `No` with no bullet.
- **Functional change:** `Yes` or `No`, then one bullet per behaviour change in plain words a product manager would follow ("admins can edit a user from the list"). `No` gets one bullet naming the kind of change ("refactor of the pricing composables").
- **Gaps:** the count, then one bullet per gap: every planned test condition with no delivered test, every acceptance criterion with no test, and each uncovered variation, each with why that's acceptable or the follow-up item. `None` (no bullets) only when true. Gaps are untested behaviour only: a missing screenshot or demo is not a gap.

### Performance (visible, performance PRs only)

- **When:** the PR is performance work: a `perf` commit or PR type, an item whose ACs set a time, count or size target, or a parent about speed. Leave it out on any other PR.
- **Never collapse it.** The benchmark is the evidence for a performance change, so a reviewer must see it without expanding anything. Keep it out of the Testing and Acceptance criteria blocks; those can point to it ("see Performance").
- **What to measure:** one row per metric the item sets a target for, plus the metrics that explain the result. **Target** is the item's number for that metric, or `None`.
- **How to measure:** the same data, the same steps and the same kind of build on both sides, medians of at least three runs. A dev build can't be compared with a production build. Name the test data by its size, never by the customer.
- **Missed target:** say so in the sentence under the table, and add it to **Gaps** with the reason or the follow-up item.
- **Not measured yet:** keep the label and write `Not measured yet: <reason>` in place of the table. Add each unmeasured target to **Gaps**.

### Screenshots

- Images from the visual-evidence step, visible, straight under the visible items. Before/after table when existing UI changed; a single image with its route or story URL otherwise.
- No images → omit it. The reason goes in the chat summary to the user, not the body.

### Acceptance criteria (collapsed)

- Summary line: AC count (including `—` rows), then `All Tested` when every row has an automated test. Otherwise name the exceptions: `1 tested manually (B)`, `1 untested (C)`.
- One row per AC, verbatim (lightly trimmed) from the item, keyed by its id in **#**. Items letter their ACs (`A`, `B`) with numbered sub-ACs (`A.1`). An unlettered item → letter them in the order the item lists them.
- Sub-ACs get their own row only when implemented or tested differently from their parent; otherwise one `A` row with `A.1 to A.3` in the AC cell.
- Dropped ACs: `Out of scope: <item>`. Delivered by another PR: `Delivered in <PR link>`.
- A `—` row for each material behaviour the diff adds that no AC covers (a new user-facing state, a flag gate, a permission check). Incidental refactors don't get one.
- **Old behaviour:** what the product did before, in user terms. `None (new)` when it didn't exist. Blank for out-of-scope and delivered-elsewhere rows.
- **Implementation:** the file, component or function that satisfies it, one line.
- **Tested by:** level, then a real test file and test name a reviewer can open. Cheapest level that proves the AC: Unit for pure logic, Integration for wiring across components or layers, E2E for cross-page or real-backend flows, Manual only when automation is impractical (say why).
- No ACs (task, chore, tech debt) → drop the block, unless the diff adds behaviour that needs a `—` row.

### Testing (collapsed)

Summary: the test levels this PR adds or changes, capitalised and joined with `&` (`Unit & Integration`, `Manual`, `None`).

- **Existing behaviour:** how regressions are covered (existing tests, an e2e run with its outcome, a manual check). Say plainly if they aren't.
- **Variations:** only when the change spans two or more dimensions (product, role, account type, flag, state, locale).
- Risks, follow-ups or a rejected alternative a reviewer needs to know go on a **Notes:** line here. Skip it when the diff makes the reasoning obvious.
- Tick the test boxes that match the tests this PR adds or changes. Tick the self-review box only when the diff has actually been reviewed.

### Related items (collapsed)

- Source: the item's links, its parent, and any item the diff or commits mention. Read each one's title.
- The item this PR delivers comes first, labelled **Item**. Then each link, labelled from this PR's side: **Unblocks**, **Blocked by**, **Relates to**, **Duplicates**, **Epic**, **Stacked on** (the base PR's item, when it differs), **Follow-up** (an item split off or created in this PR).
- One sentence per link on how *this PR* relates. No item and no links → drop the block.

### Dependencies (collapsed)

Drop the block unless a manifest or lockfile changed (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `build.gradle*`, `pom.xml`, or the lockfile). Tick the boxes, then per dependency:

**New dependency**: a health table, then one-line verdicts:

```markdown
| Package | Version | License | Stars | Last release | Release cadence | Weekly downloads | Open issues | Audit | Size |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

**Why needed:** <what it does that we can't reasonably do in-house><br>
**Alternatives considered:** <pkg> (<why not>); <in-house> (<why not>)<br>
**Risk:** <bus factor, maintenance, transitive deps, CVEs, licence compatibility>
```

Sources: the registry (`npm view <pkg> license time versions repository --json`, `cargo info`, `pip index versions`), `gh api repos/<owner>/<repo> --jq '{stars:.stargazers_count, pushed:.pushed_at, issues:.open_issues_count, archived:.archived, license:.license.spdx_id}'`, the ecosystem's audit command, and bundle size for front-end packages. Flag copyleft licences (GPL/AGPL/LGPL), archived repos, no release in 12 months, or a single maintainer.

**Upgrade**: from → to, then:

```markdown
| Change | Affects us? | Callsites / evidence |
| --- | --- | --- |

**Migration guide:** <url or None><br>
**Release notes:** <url>
```

"Affects us?" is evidence-based: search the repo, cite `file:line` or say why it doesn't touch us. Deprecations: applied here, or the follow-up item. A PR from `update-library` embeds that skill's filled template here, heading demoted to `###`.

**Removal/downgrade**: one line on why, and confirm nothing still imports it.
