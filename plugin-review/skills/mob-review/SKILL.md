---
name: mob-review
description: Run the full staff-engineer review panel over a PR or branch. Spawns every in-scope persona reviewer (security, code-quality, naming, comments, error-handling, architecture, test-design, integration-test, performance, resilience, pr-size, api-design, database, github-actions, shell, typing, a11y, async-state, ac-check, production-protector, skills, plus any repo-local personas) and Claude's built-in /code-review at medium effort in parallel against the diff, aggregates their findings into one ranked report, then applies the small clear-cut fixes when the branch is your own (report-only on someone else's). The panel comes from `review.personas` / `review.exclude` in overbridge.yml; with no config each persona's diff-signal guard decides. Use when the user says "mob review", "mob-review", "review this PR", "run the panel", "full review", or wants a broad multi-lens review of the current branch or a given PR.
---

# Mob Review: staff-engineer review panel

Spawn every in-scope `persona-*` reviewer in parallel over one diff, then aggregate their findings into a single ranked report. Each persona is a narrow, non-overlapping specialist; this skill is the orchestrator.

## Extensions

Extension files can add to this skill without changing it. At each step marked `ext: <phase>`, run
`overbridge ext mob-review <phase>` before you do the step, and follow what it prints as well as this skill. Where
the two conflict, the extension wins. It prints nothing when there is no extension. Its phases: `panel`.

## The panel

Built-in personas ship in this plugin as sibling skills (`persona-<name>`). Repo-local personas live in the repo (see Step 2). A persona runs only when selected (Step 2) **and** its guard matches the diff.

| Persona skill | Reviews | Guard (runs only if…) |
|---|---|---|
| `persona-a11y` | semantic HTML, ARIA, labels, focus, keyboard | UI markup changed: `.vue`, `.jsx`/`.tsx`, `.svelte`, `.html`, or a server-rendered template. Hunks that only touch routing/metadata don't count |
| `persona-comments` | needless/stale/what-not-why comments, over-long comments, commented-out code | any source file with added or changed comment lines |
| `persona-naming` | file/folder/export/variable naming and units | new files added, files renamed, or exported/declared identifiers changed |
| `persona-code-quality` | extraction, dedup, misplaced code, stdlib/library reuse | **non-test** source changed |
| `persona-error-handling` | swallowed failures, logging instead of reporting, context-free `throw`, unhandled rejections, `fetch` without a status check | the **changed lines** touch a failure path (`catch`, `finally`, `throw`, `raise`, `except`, `.catch(`, `.then(`, `reject`, `onError`, error logging, `fetch(`, `Promise.`, an `*Error` type) in **non-test** source. Judge the hunks, not the file. Bare `async`/`await` is not a trigger on its own, and matches inside test files never count |
| `persona-async-state` | races and stale async state: out-of-order responses, in-flight writes into reset state, state re-read after an `await`, conflicting writes left enabled, placeholder data faking a loaded query, last good data kept after a failure | the **changed lines** touch async state: `await`, `.then(`, an async watcher/effect, a mutation or query hook, pending/loading/error flags, `AbortController`/`signal`, or a logout/reset/context-switch handler. Non-test source only. Judge the hunks, not the file. Rebinding a handler to a different function doesn't count; the handler's own body has to change |
| `persona-resilience` | what happens when the session, network, another tab or a deploy changes under a task: lost work on session expiry, parallel 401s, 4xx retries, whole-resource PUT overwrites, duplicate creates, unguarded storage, hung requests, polling, stale chunks after deploy | the **changed lines** of non-test source touch an HTTP client or interceptor, 401/403 handling, an auth or session store, query/cache client config, `retry`/`retryDelay`/`refetchInterval` style options, cross-tab messaging or `storage` events, web storage, abort handling in a client, dynamic-import error handling, or a save that sends a whole resource. Judge the hunks, not the file |
| `persona-architecture` | cross-layer coupling, logic in the wrong layer, shell↔page coupling | non-test source under an application or shared library changed, or backend build/config changed (`build.gradle*`, `settings.gradle*`, `pom.xml`, `*.proto`, `application*.yml\|properties`) |
| `persona-security` | XSS sinks, reverse-tabnabbing, wildcard `postMessage`, dev flags in prod, CSV formula injection, tokens in web storage, secrets/PII to telemetry, backend injection and authz | **non-test** source or repo tooling changed; or, for its config/test-file rules only, env files, `.gitignore`, compose files, build files, `*.sql`, test fixtures changed |
| `persona-typing` | casts (`as`, `as unknown as`, `!`), inferred-type gymnastics, `Omit<>` over-use, missing generics, mutable global consts, nullability annotations | `.ts`/`.tsx`/`.mts`/`.d.ts`/`.vue` source or `.kt`/`.java` changed, tests included |
| `persona-github-actions` | workflow/action CI security and best practice (injection, permissions, action pinning, secrets) | `.github/workflows/*` or `.github/actions/**` changed |
| `persona-shell` | swallowed exit statuses, `set -euo pipefail`, SIGPIPE, quoting, unstable-output parsing, signal semantics | `*.sh`/`*.bash` or a file with a shell shebang changed, or a multi-line `run:` block changed in a workflow/action |
| `persona-skills` | agent-instruction correctness: dangling skill/tool/path references, contradictions, non-invocable targets, unset placeholders, single-user assumptions, unbounded waits, manifest drift | `SKILL.md` or anything under `skills/<name>/`, `agents/*.md`, `commands/*.md`, `.claude/**`, `CLAUDE.md`/`AGENTS.md`, or a `.claude-plugin/*.json` / `hooks/hooks.json` changed |
| `persona-api-design` | OpenAPI/REST design: casing, versioning, ids, methods/status codes, error shape, pagination/sorting, PATCH semantics, operationIds/examples, compatibility | an OpenAPI spec (`openapi/**`, `*.yaml`/`*.yml` with an `openapi:` key) changed, or changed lines touch route/controller annotations or pagination handling |
| `persona-database` | migrations, datafixes, audit tables, drop/rename sequencing, ORM entity mapping, native-query sort allowlists | a migration/changelog file changed (`**/migrations/**`, `**/changelog/**`, Flyway `V*__*.sql`, Alembic, Prisma, Liquibase), or changed lines touch entity/table/column mapping or native queries. A directory merely named `changelog` with no migration content doesn't count |
| `persona-integration-test` | integration/e2e flakiness and speed, test isolation, real-dependency tests | an integration or e2e test changed (Playwright/Cypress specs, `*IT.*`, tests using `@SpringBootTest`/`MockMvc`/Testcontainers/WireMock), or a network-mock handler changed |
| `persona-test-design` | what *should* be tested: risk-rated behaviours, conditions from partitions/boundaries, decision tables, state transitions; high-risk gaps and wrong test level. Capped at five findings | **non-test behavioural source** changed, **whether or not the diff touches a test**. Type-only, style-only, docs, CI, lockfile and locale hunks don't count, and a test-only diff doesn't either |
| `persona-ac-check` | PR (code + description) ↔ work-item acceptance-criteria coverage; recommends update-the-item vs update-the-PR | a work-item id is resolvable from the branch or PR title and `overbridge item view <id>` succeeds |
| `persona-pr-size` | PR too big or splittable; proposes a `gh stack` split layout | diff is large by **changed-line count** (~≥400) or obviously bundles unrelated concerns. File count alone is not a split signal |
| `persona-production-protector` | production blast radius: missing/leaking/fail-open feature gates, flipped defaults, in-place shared-lib changes, global-scope edits, delete-before-proven, one-way changes, tightened contracts, rollback story | shipped non-test source changed (skip test-, docs- and CI-only diffs; **except** a test diff that provisions privileged accounts, grants roles, or mutates a shared environment) |
| `persona-performance` | runtime cost that grows with data size or session length: full-list scans per row, needless writes, leaked observers/timers, unwindowed lists, heavy default refetches, layout/paint traps | the **changed lines** of non-test source touch a computed/getter, a loop over rows, a row component, a store write, a query definition, a watcher, a timer, a third-party instance, or sign-in/bootstrap code. Judge the hunks, not the file |
| `persona-<local>` | whatever the repo's own persona says | per its own guard |
| `code-review` (built-in skill, not a persona) | general correctness bugs: logic errors, broken edge cases, wrong conditions, crashes (the cross-cutting catch-all no single lane owns) | always (any non-empty diff), at `medium` effort. See Step 3 |

## Step 0: Run the panel in a clean thread

**The panel is cheap; the thread it runs in is not.** Reviewing a diff needs the diff, the item and the repo. Not the conversation that produced the change. Run at the tail of an implementation session, the panel pays for that whole history on every one of its orchestration turns: spawns, every persona report, fixes, verification, re-review.

- **Arriving from a session that just wrote the code** (`loop-item`) → the implementation is committed. Tell the user the panel will cost several times more here than in a fresh thread, and offer `/clear` followed by `/mob-review` with a one-paragraph summary of what the commits don't show (changes from the plan, checks skipped).
- **Already in a fresh or short thread** (`/review-pr`, a session opened to review) → straight to Step 1.
- **User declines** → run anyway. Say once that it will cost several times more, then drop it.

Step 6.3's re-review round is the most expensive part of a panel for the same reason: it lands at the deepest context.

## Step 1: Resolve target and compute the diff scope

Accept an optional argument: a PR number/URL, a branch name, or nothing.

**Run from inside the repo directory of the workspace that holds the work.** The panel reviews one repo's diff; a workspace spanning several repos gets one run per repo. For a PR that isn't checked out here, use `review-pr`, which claims it with `overbridge checkout` first. Never `gh pr checkout` or `git switch`: the workspace guard blocks them and they bypass the claim.

```sh
git fetch origin main --quiet
```

- **No arg / branch:** review the current (or named) branch vs `origin/main`.
- **Stacked PR** (`gh pr view --json baseRefName` is not `main`): review vs `origin/<baseRefName>` instead, in every `git diff` below and in what the personas and `code-review` are told. The base branch's commits are its own PR's to review.
- **PR number/URL:** the branch must already be checked out through `overbridge checkout <repo> '#<n>'`. If it isn't, run `review-pr` instead.

Compute the changed-file list and the diff **once, to disk**, and hand every persona those paths instead of a command each one re-runs. Use the session's scratchpad directory when the system prompt names one, else `${TMPDIR:-/tmp}`:

```sh
SCRATCH="${TMPDIR:-/tmp}/mob-$(git rev-parse --abbrev-ref HEAD | tr / -)-$(git rev-parse --short HEAD)"
mkdir -p "$SCRATCH"
git diff --name-only --merge-base origin/main HEAD > "$SCRATCH/files.txt"
git diff        --merge-base origin/main HEAD > "$SCRATCH/diff.patch"
git diff --stat --merge-base origin/main HEAD | tail -1
cat "$SCRATCH/files.txt"
```

The path is keyed by branch **and sha**, so a re-review round after a fix commit computes its own patch and can never read a stale one.

**Uncommitted work.** If the branch has no commits ahead of `origin/main` but the working tree is dirty, review the working tree instead: drop `HEAD` from the three `git diff` commands (`git diff --merge-base origin/main` includes staged and unstaged changes) and suffix `SCRATCH` with `-wt`. Step 6 then can't make a separate fix commit; leave the fixes in the working tree and say so.

If `files.txt` is empty, report "no changes vs origin/main" and stop.

**Branch behind `main`.** A merge-base diff still carries commits that already landed on `main` by squash merge, so the panel would review code that is not this PR's change. When `git rev-list --count HEAD..origin/main` is non-zero, compare `git diff --stat --merge-base origin/main HEAD` against the diff a merge would leave: `git diff --stat origin/main $(git merge-tree --write-tree origin/main HEAD | head -1)`. If the second is clearly smaller, stop and offer to run `merge-main` first (own code, if that skill is installed; otherwise a plain merge) or tell the author (someone else's), then recompute the scope. Conflicts reported by `merge-tree` are part of the offer.

**Never print the patch body into this thread.** The orchestrator needs the file list (Step 2 guards) and the `--stat` line (size); the personas read the diff from `diff.patch` themselves. A diff pasted here is re-sent on every remaining turn of the review.

Also record **whose code this is**. It decides whether Step 6 may apply fixes:

```sh
git config user.email                                                       # you
git log --format='%ae' $(git merge-base origin/main HEAD)..HEAD | sort -u   # branch authors
```

**Own code** = every commit on the branch is authored by the current git user. Anything else (a commit by another author, or a PR you picked up from someone else) is **someone else's code**. When in doubt, treat it as someone else's.

**What Copilot already said.** The panel never re-reports an issue a bot reviewer has already raised on the PR. The author has seen it there. If the branch has a PR (`gh pr view --json number -q .number`; none, or uncommitted work → skip this), save every Copilot comment to the scratch dir, resolved and outdated ones included:

```sh
PR=$(gh pr view --json number -q .number)
{
  gh api --paginate "repos/{owner}/{repo}/pulls/$PR/comments" \
    --jq '.[] | select(.user.login | test("copilot"; "i")) | {path, line: (.line // .original_line), body}'
  gh api --paginate "repos/{owner}/{repo}/pulls/$PR/reviews" \
    --jq '.[] | select(.user.login | test("copilot"; "i")) | select(.body != "") | {path: null, line: null, body}'
} > "$SCRATCH/copilot.jsonl"
wc -l < "$SCRATCH/copilot.jsonl"
```

Review bodies count too: Copilot lists its low-confidence comments there with a file and line instead of posting them inline. Don't print the file here; Step 4 reads it.

## Step 2: Select the panel

`ext: panel`: run `overbridge ext mob-review panel` first (extra reviewers or personas to run).

Resolve the candidate list from the repo's `overbridge.yml`, then apply guards.

```sh
overbridge config get review.personas       # JSON list; non-zero exit when unset
overbridge config get review.exclude        # JSON list, [] by default
overbridge config get review.local-dir      # default .overbridge/personas
```

1. **Candidates.**
   - `review.personas` set → exactly those names (a name is the persona skill without its `persona-` prefix: `security`, `code-quality`). A name that matches no built-in and no local persona is an error: list it and stop, since a typo would silently shrink the panel.
   - Unset → every built-in persona plus every local persona.
2. **Local personas.** Look in `<local-dir>` (relative to the repo root) for `<name>/SKILL.md` or `<name>.md`, in the same format as a built-in persona (frontmatter, Guard, Scope, What you review, Out of lane, Severity, Output). A local persona with the same name as a built-in **replaces** it. The directory may not exist. That's fine.
3. **Exclude.** Drop every name in `review.exclude`, even one named in `review.personas`.
4. **Guards.** Match the changed-file list and diff against the guard column. Only launch personas whose guard matches. This is a coarse pre-filter to avoid spawning obviously-irrelevant reviewers. Each persona also self-guards as a backstop and returns zero findings if truly out of scope. A configured persona (`review.personas`) still has to pass its guard: the config picks the panel, the diff decides who has work. A local persona's guard comes from its own `## Guard` section.

Note which personas you skipped and why (shown in the final table). Say whether the panel came from config or from guards alone.

## Step 3: Spawn the in-scope personas in parallel

Launch **one subagent per in-scope persona, all in a single message** (multiple `Agent` tool calls) so they run concurrently. Use the `general-purpose` agent type. The harness runs at most 20 subagents at once and refuses the rest; when the panel plus `code-review` exceeds that, launch the overflow as the first reports come back.

**Model per persona.** A persona reads a bounded diff and answers against a written rubric, so pass `model: "sonnet"` on the `Agent` call for every persona *except* the following, which stay on the default model because their misses are silent and expensive:

- `persona-security`
- `persona-production-protector`
- `persona-architecture`
- `persona-database` (migration and drop/rename mistakes are one-way)
- `persona-skills` (its defects are relational: it has to read across files to find them)
- `persona-test-design` (a missing test is invisible in the diff: it has to reason from the source to conditions nobody wrote, and rate risk)

Local personas default to `sonnet` unless their frontmatter says otherwise.

Ticket context in the prompt is fine. The author's beliefs about behaviour are not facts. Pass a claim like "the old component rendered aria-hidden" only as something to verify, or leave it out, because a persona that accepts it as given skips the check its lane exists for.

The built-in persona skills are sibling directories of this skill: set `PERSONAS` to the parent of this skill's base directory (shown when the skill loads) and substitute the absolute path into the prompt. A subagent cannot resolve `$SKILL_DIR` or a plugin-relative path on its own. Tell each subagent that inside its persona file `$SKILL_DIR` means the persona's own directory. For a local persona, the path is the one found in Step 2.

Give each the same diff context and this exact contract:

> Read `<PERSONAS>/<persona-name>/SKILL.md` and follow it exactly as a code review of the diff below. **Do NOT call ReportFindings**. Instead, return your result as your final message, as raw JSON only (no prose, no code fences) matching this schema:
> ```json
> {
>   "persona": "<persona-name>",
>   "inScope": true,
>   "findings": [
>     { "severity": "change-requested|nit|future", "category": "<slug>", "file": "path", "line": 123, "summary": "one sentence", "detail": "why it matters / concrete failure scenario", "suggestion": "concrete fix" }
>   ]
> }
> ```
> **Code references.** Any code you cite that is *not* a changed line of this diff must be a markdown link to that line on the default branch on GitHub, in `detail`/`suggestion`. That covers code in another repo and unchanged code elsewhere in this repo. Format: `[path/File.kt:42](https://github.com/<owner>/<repo>/blob/main/path/File.kt#L42)`, or `#L42-L50` for a range. Take the line numbers from `origin/main`, never the local checkout, because local clones lag: `git fetch origin main --quiet && git grep -n '<pattern>' origin/main -- <path>`. Get `<owner>/<repo>` from `git remote get-url origin`. For a repo that isn't on GitHub, give plain `path:line` plus the remote URL. Changed lines of the diff stay in `file`/`line`; they aren't on main yet.
>
> `line` is the line number in the changed file on the branch (the `+` side of the hunk), never a line number within `diff.patch`.
>
> If your guard says you are out of scope, return `{"persona":"<persona-name>","inScope":false,"findings":[]}`. Only report findings you have verified against the actual changed lines. No speculation. Stay strictly in your lane; another persona covers everything outside it.
>
> Diff scope: branch vs `origin/main`, already computed: **do not recompute it**.
> - Full patch: `<SCRATCH>/diff.patch`
> - Changed files: `<SCRATCH>/files.txt`
>
> Read the patch from that file: whole, or one file's section at a time with `awk '/^diff --git/{p=0} /^diff --git.*<path>/{p=1} p' <SCRATCH>/diff.patch`. Re-running `git diff` costs the panel the same bytes once per persona, so only do it if you need context the patch cannot give you: surrounding lines of a changed file, or a file the diff does not touch.

For `persona-ac-check`, also give the work-item id (from the branch or PR title) and the PR number if there is one.

**Built-in `/code-review`, same message.** Alongside the personas, spawn one more `general-purpose` subagent on the **default model** (correctness misses are silent, like security's) that runs Claude's own review:

> Invoke the `code-review` skill via the Skill tool with args `medium <branch>` (the branch under review, compared against `origin/main`; the diff is also at `<SCRATCH>/diff.patch`). Follow it as a **review only**: no `--fix`, no `--comment`, no edits. **Never write to the working tree or index**: no `git checkout`/`restore`/`stash`/`reset`/`switch`, since the orchestrator may hold uncommitted fixes there. To see another revision, read it with `git show <rev>:<path>`. **Do NOT call ReportFindings**: when the skill reaches its reporting step, return raw JSON only (no prose, no code fences) using the persona schema above with `"persona": "code-review"`. If the skill runs its review in the background, wait for that run to finish before returning: an empty report sent while it is still running reads as a clean result. Map severity: a correctness bug (`CONFIRMED`, or a `PLAUSIBLE` one with a concrete failure scenario) → `change-requested`; a reuse/simplification/efficiency cleanup → `nit`; drop anything else speculative. `detail` = the failure scenario, `suggestion` = the fix. Any code it cites outside the changed lines must be a markdown link to that line on the default branch on GitHub, with line numbers taken from `origin/main` (same rule as the personas).

Skip `code-review` when `review.exclude` lists `code-review`.

Medium is deliberate: at low/medium the skill keeps to fewer, high-confidence findings, which is what a panel already full of specialists wants from a generalist. Don't raise it without the user asking.

## Step 4: Aggregate

Collect each persona's JSON (drop any that failed to parse, and say which). Combine all `findings`. Do not re-litigate or merge across personas: lanes don't overlap by design, so duplicates indicate a persona strayed; drop the out-of-lane one.

`code-review` has no lane, so it will overlap. When one of its findings names the same file/line and the same problem as a persona finding, keep the persona's (it carries the lane's rubric) and drop the `code-review` copy. Its cleanup nits that sit squarely in `persona-code-quality`'s lane go the same way when that persona ran. So does a `code-review` finding that an in-lane persona's SKILL.md lists as an explicit exception, even when that persona reported nothing.

Known persona pairs that can land on the same line, resolved the same way every time:

- **`persona-production-protector` (irreversible/one-way change) vs a `persona-database` drop/rename sequencing finding** on the same line → keep `persona-database`'s mechanics finding and fold production-protector's rollback verdict into its `detail`.
- **`persona-test-design` versus a behaviour-persona finding** (`persona-error-handling`, `persona-async-state`, `persona-resilience`) on the same code → keep both: one names the defect, the other the missing test. Put them next to each other in the report.

**Drop anything Copilot already raised.** If Step 1 saved a non-empty `$SCRATCH/copilot.jsonl`, compare every remaining finding against it and drop the ones Copilot already covered: same file, within a few lines (or cited in a review body), and the same underlying problem, however differently worded. Severity doesn't matter. A finding on the same line but about a different problem stays. When unsure whether it's the same problem, drop it. Keep a count of drops per persona for the Step 5 table.

**Triage for merge, not polish.** The panel protects production and gets the change merged. It is not there to polish. Apply these after the Copilot drop, using the Step 1 ownership check:

- **Performance (any code).** Keep a performance finding only when the cost is major: it grows with data size or session length until a user can see it (a freeze, a leak, a full-list scan per row, a request per row), or it adds a heavy dependency to a first load. Drop minor and speculative ones ("could memoise", "allocates a new array", a saving no one would notice). Premature optimisation is not a finding.
- **Someone else's code.** Drop most nits. A nit stays only when it describes behaviour a user or production would notice. Style, naming, comments, type tidy-ups, `readonly`, simplifications, and missing tests don't make the cut. Downgrade a `change-requested` to `nit` when no concrete production failure sits behind it (a standards deviation, a test-structure complaint, or a missing test case), then apply the nit rule to it.
- **Own code.** Keep nits: Step 6 fixes the small ones for free, and the author asked for the full read. Still downgrade a `change-requested` with no concrete production failure to `nit`.

Count what triage dropped or downgraded per persona for the Step 5 table.

**Check the rest of the stack.** When the branch has PRs stacked above it, a later PR may already fix a finding. Find them by walking up from this branch:

```sh
gh pr list --base <branch> --state open --json number,title,url,headRefName   # repeat with each headRefName until empty
```

(`gh stack view` shows the same chain.) No PRs above → skip this. Otherwise fetch the top of the stack (every tip, if the chain forks) and, for every remaining finding, read the cited code there (`git show origin/<top headRefName>:<file>`), following a rename or move if the file is gone. Check the problem itself, not only the line:

- Fixed higher in the stack → drop it, and note `fixed in <PR title>` for the Step 5 table.
- Partly fixed, or fixed in a way that still fails → keep it and add one clause to `detail`: what the later PR changes and what is still wrong.
- Not touched → keep it as it is.

A PR below this one gets its own review; don't check it.

Rank: **change-requested → nit → future**, then group by persona within each tier.

## Step 5: Report once

Call `ReportFindings` a single time with the aggregated, ranked findings:

- Order most-severe first (all change-requested, then nit, then future).
- `summary`: prefix with the tier and persona, e.g. `[Change Requested] (a11y) icon button has no accessible name`.
- `category`: the persona slug (so findings group by reviewer in the UI).
- `file`, `line`: from the finding.
- `failure_scenario`: the finding's `detail`, plus `suggestion`. Keep the personas' markdown GitHub links to `main` intact. If a finding cites out-of-diff code as a bare `path:line`, convert it to a link before reporting (resolve the line on `origin/main`).

Then print a compact coverage table so the user sees what ran:

```
Persona            CR  Nit  Future   Status
a11y                1    2       0   ran
security            0    0       0   ran (clean)
database            —    —       —   skipped (no migration changes)
pr-size             —    —       —   skipped (review.exclude)
...
code-review         1    0       0   ran (medium)
```

Counts are after the Copilot filter and triage. When the filter dropped anything, add one line under the table: `Dropped N findings Copilot already raised (<persona>: n, …).` When triage dropped or downgraded anything, add one more: `Triage dropped N and downgraded M (<persona>: n, …).` When later PRs in the stack fixed anything, add `Fixed later in the stack: N (<PR title>: n, …).` Don't list them.

If every persona is clean, say so plainly. A clean panel is a valid result.

## Step 6: Apply the simple findings (own code only)

**On your own code** (per the Step 1 ownership check), don't stop at reporting. Fix what is small and clear-cut, then report what you fixed. Waiting to be asked wastes a turn on changes the user would always approve.

**On someone else's code, apply nothing.** Report and stop. Editing another person's branch is theirs to invite, and the findings are the deliverable. Say in one line that fixes were withheld because the branch isn't yours.

Judge each finding on **size and certainty**, not on its severity tier. A `change-requested` can be a one-liner and a `nit` can be a redesign:

**Apply** when the fix is mechanical or local, and there is one obvious right answer:
- Deleting a redundant wrapper, duplicated mapping, or vacuous assertion
- Extracting a shared helper or test fixture already duplicated verbatim
- Adding a test case for an uncovered branch that the existing harness already supports
- Renames, missing `readonly`/`as const`, tightening a loose type

**Leave for the user**. Report with a recommendation instead:
- Anything that changes public API, a component contract, or an exported type
- Anything touching behaviour the tests don't pin down, or needing a product/design call
- Refactors spanning several files, or that would restructure a module
- Anything where two reasonable fixes exist and picking one is a judgment call the author should make
- Anything a persona itself flagged as `future` and framed as its own ticket

Then, for everything you applied:

1. **Prove each fix.** For an added test, mutate the source it targets, confirm the new test goes red, and restore. A test that passes either way covers nothing. For a refactor, the existing tests must stay green.
2. Run the repo's own checks on the touched code, smallest scope that proves the change:
   ```sh
   overbridge config get commands.typecheck
   overbridge config get commands.lint
   overbridge config get commands.format
   overbridge config get commands.test      # a single file or project first; ask before a full suite
   ```
   A key that is unset means the repo has no such command: say so rather than guessing one. Follow the repo's `CLAUDE.md`/`AGENTS.md` for how to scope a run.
3. **Re-review your own fixes: narrowly.** The panel read the original diff; your fix commit went in unreviewed, and a fix is where a fresh defect lands (a moved symbol, a weakened assertion, a rename that missed a caller). But this round is the most expensive thing the panel does: it fires at the deepest context of the session, so it is scoped to where a fix can actually go wrong, not re-run across the board.

   **Skip the round entirely when every applied fix was a nit**: a redundant comment removed, a `readonly` added, a rename. Nits are mechanical by definition; if a fix needed judgement it was not a nit and does not qualify for the skip. Say in the report that the round was skipped and why.

   Otherwise spawn it over **the fixes alone**, never the whole branch diff again, from their own scratch patch. This runs before step 4, so the fixes are normally still uncommitted:

   ```sh
   SCRATCH="${TMPDIR:-/tmp}/mob-fix-$(git rev-parse --short HEAD)-$(date +%s)"
   mkdir -p "$SCRATCH"
   git diff HEAD > "$SCRATCH/diff.patch"                                  # uncommitted fixes
   [ -s "$SCRATCH/diff.patch" ] || git show HEAD > "$SCRATCH/diff.patch"  # already committed
   ```

   Give each persona the Step 3 contract plus what was already verified, so it doesn't re-report settled ground. Spawn only:
   - **Personas whose own findings you applied.** A persona that reported nothing, or whose findings you left for the user, has nothing of its own to re-check.
   - **`persona-integration-test` whenever you added or changed an integration test**, and **any persona whose lane covers a test file you added** (its guard ran against the original diff, so a test the panel itself introduces is otherwise never reviewed).
   - **Any persona whose guard your fixes newly satisfy** (a fix that touches markup when the diff had none → `persona-a11y`).
   - **`code-review` at `low`, only when you applied one of its `change-requested` findings**: a bug fix is the likeliest place for a new bug. Point it at the fix scratch patch, not the branch.

   A persona whose lane a fix merely passed through, without that persona having asked for the fix, is **not** in this round.

   **One round, hard cap.** Drop its findings Copilot already raised (Step 4's filter), apply the same size-and-certainty judgement to the rest, then report whatever remains rather than spawning a third round.
4. Commit as one commit in the repo's commit convention (Conventional Commits by default, e.g. `refactor(<scope>): act on mob-review findings`, or `fix(...)` if behaviour changed), body listing what changed and why. Push if the branch already has a PR.
5. In the final summary, mark every finding `applied` / `left for you`, so the report stays a complete account of the panel's output.

## Step 7: Persona calibration (apply confident refinements)

The panel improves by watching itself. After reporting, scan **this run** for persona-quality signals and draft fixes to the relevant persona.

**Where an edit goes:**
- A **repo-local** persona (under `review.local-dir`) → edit it in this repo.
- A **built-in** persona → never edit the installed plugin copy, since plugin installs are overwritten on update. The change belongs in a checkout of the overbridge repo under `plugin-review/skills/`, as a PR. Offer to open it; don't open it unasked.

- **Confident** (the evidence from this run clearly shows the persona got it wrong, and there is one obvious edit) → **draft the edit**, then list it in the summary with the persona, the evidence, and the line changed.
- **50/50** (a reasonable reviewer could side with the persona, or the fix could go more than one way) → **don't edit**. Propose the change and let the user decide.

Keep edits surgical: add an exception, tighten a guard or "Out of lane" entry, or adjust a severity. No rewrites of a persona's structure. Write the rule as it stands, with no item ids, run history or `(Observed: …)` notes. The evidence goes in this run's summary, not in the persona.

Signals to look for:

- **Convention conflict → false positive.** A finding contradicts a documented convention (`CLAUDE.md`, `AGENTS.md`, or a recalled memory). The persona is missing that exception. → Propose adding the exception to its "What you review".
- **Lane stray.** A persona reported something another lane owns (a finding you dropped in Step 4). → Propose tightening its "Out of lane" list.
- **Mis-guard.** A persona was spawned but returned `inScope:false` (guard too loose), or a clearly-relevant persona got skipped (guard too tight). → Propose a guard-column tweak.
- **Systematic noise / miss.** A persona that keeps firing the same low-value nit, or misses a pattern its lane explicitly claims. → Propose a severity or scope adjustment.

For each signal: name the persona, the observed behaviour, and the SKILL.md change, marked `applied` or `proposed (50/50)`. Back every change with evidence from this run. No speculative rewrites. If nothing surfaced, say "no persona changes." When a persona's description, guard or existence changes, update its row in this skill's panel table in the same pass.

Reviewer feedback on the eventual PR is the stronger calibration signal: if the `resolve-feedback` skill is installed, its closing phase mines Copilot and human comments to refine the same personas. This step is the read-time counterpart.

## Notes

- The personas themselves are read-only: they review, they never edit. Applying fixes is this orchestrator's job in Step 6, and only on your own code.
- Personas are independently invocable too (e.g. run just `persona-security`). This skill is for the full sweep.
- Scale is bounded by the diff: a small PR launches few personas; a broad one launches many. That's intended.
- Skills this one calls: `code-review` (built in). Optional: `merge-main` and `resolve-feedback` from the `overbridge` plugin, when installed. Nothing here needs `pickup`.
