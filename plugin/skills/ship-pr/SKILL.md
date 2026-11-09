---
name: ship-pr
description: Commit, push and open (or update) a GitHub PR from an overbridge workspace, then record the PR against the workspace, wait for a green build, request Copilot and CodeRabbit reviews (CodeRabbit also on drafts) and resolve their feedback. Fills the PR body from the shared template (visible change summary and gaps, a benchmark table on performance PRs, screenshots; everything else collapsed). Handles a single PR on the default branch, a stacked PR on top of another branch or PR (always a real gh stack), and splitting one oversized branch into a stack. Use when the user says "ship it", "open a PR", "raise a PR", "push this up", "update the PR", "stack this on X", "on top of #123", "restack this onto X", "split this into a stack", "break this PR up", or "stacked PR". Pass `--with-review` (or say "review and open a PR") to run mob-review first.
---

# Ship a PR from a workspace

Commit the work, push the branch, open a PR with the shared body template, get the build green and the review feedback resolved. Everything runs from the repo directory inside the workspace, on the branch the workspace has claimed.

`overbridge` owns branch changes. Never `git switch`, `git checkout <branch>` or `gh pr checkout`: the guard blocks them and they bypass the claim. To discard file changes use `git restore <path>`.

## Extensions

Extension files can add to this skill without changing it. At each step marked `ext: <phase>`, run
`overbridge ext ship-pr <phase>` before you do the step, and follow what it prints as well as this skill. Where
the two conflict, the extension wins. It prints nothing when there is no extension. Its phases: `commit`, `screenshots`, `pr-body`, `post-pr`, `prose`.

## Run to completion

Invoking this skill ("ship it", "open a PR", "stack this") is the approval to commit, push, open the PR as a draft and drive it to a green build, with no question in between. Do steps 1 to 12 in one run. Never stop to ask "want me to push / submit / write the descriptions?" and never end the turn on a list of what is not done yet: do it, or say in the final summary why a step was skipped.

That holds when you own the repo. Check once, at step 1:

```sh
gh repo view --json viewerPermission,isInOrganization --jq .viewerPermission    # ADMIN or MAINTAIN: yours
```

`ADMIN` (an owner or org admin) means run without asking, public or private. Anything else is someone else's repo, where a push and a PR are visible to its owners: show the title and the one-line body summary once, and wait for a yes before pushing. The lines below that say "ask" apply only then, or when the input is genuinely ambiguous (no way to infer a branch name, a diverged lower branch).

## Arguments

- `--with-review`: run `mob-review` (from the `overbridge-review` plugin) before the push without asking. Natural-language equivalents count: "review and open a PR", "mob review then PR".
- **A base** ("stack this on X", "on top of #123", "restack onto X"; X is a branch, a PR number or a PR URL): this is a stacked PR. Read *Stacked PRs* below before anything else.
- **"Split this"**: read *Splitting an oversized branch* below.

## 1. Check state

```sh
overbridge status
```

Confirm the repo has a claimed branch: not detached, not the default branch. On the default branch or detached, ask for a branch name and run `overbridge checkout <repo> <branch>`; uncommitted changes carry over. If `status` shows a `stack` entry, or the branch was branched off another feature branch with its own open PR, this is a stacked PR.

If the branch is already stacked on another and the user did not ask for a stack, say so: the PR must target its stack base, not the default branch. Read *Stacked PRs*.

## 2. Gather context

In parallel:

```sh
git status
git diff && git diff --cached
git log --oneline -10
git branch --show-current
gh repo view --json defaultBranchRef -q .defaultBranchRef.name      # <default>, the base of a normal PR
overbridge item from-branch                                          # item id the branch names; fails if none
```

`git log origin/<default>..HEAD --oneline` lists the commits already on the branch (use the stack base instead of `<default>` for a stacked PR).

With an item id, read it for the PR body's acceptance criteria and links: `overbridge item view <id>` gives `{id,title,url}`; the body and comments come from the provider's own CLI, picked by `overbridge config get project-management.name`:

- `github`: `gh issue view <id> --comments`
- `jira`: `jira issue view <id> --comments 20`

Also note other items the commits or the diff mention (`TODO(<id>)`). No item id → the PR has no AC table and no Related items; that is fine.

## 3. Check the change

Run the repo's own checks, smallest scope first, and fix failures before committing:

```sh
overbridge config get commands.typecheck
overbridge config get commands.lint
overbridge config get commands.format
overbridge config get commands.test
```

An unset key means the repo has no such command: say so rather than guessing. Run a single file or project before the whole suite, and ask before an expensive full run. Follow the repo's `CLAUDE.md` for how to scope a run.

Run each through the repo's dev shell: `overbridge shell <repo> -- <command>` (it runs the command as it is when the repo declares no `shell`).

## 4. Commit

`ext: commit`: run `overbridge ext ship-pr commit` first (the commit message convention).

If there are uncommitted changes:

- Stage explicit file names, not `git add -A`. Never stage secrets (`.env`, credentials, tokens), build output or screenshots.
- Draft the message in the repo's convention (its `CLAUDE.md`, or Conventional Commits by default): subject ≤ 50 chars, body explains why, `Refs <id>` when there is an item. End it with the attribution lines the session's instructions specify, and add none if none are specified.
- Commit without asking. On a repo you do not own, show the message, the PR title and the one-line body summary in one question first.
- Commit with a HEREDOC. If a pre-commit hook fails, fix the cause and make a **new** commit; never amend.

All changes already committed → skip.

## 5. Review gate

The panel reads the diff a reviewer is about to read. If the `overbridge-review` plugin is installed and this branch has not been through `mob-review` in this session, do not ask about it: run it only with `--with-review` (or when the user asked for a review). Otherwise open the PR as-is and say plainly in the final summary that it has not been through the panel; do not write that into the PR body.

With `--with-review`, skip the question and invoke `mob-review`. Its own clean-thread check still applies. It may leave a fix commit on the branch; that commit goes out with the push.

A stacked PR is reviewed per layer: a review of the layer below says nothing about this one.

## 6. Push

Plain branch: `git push -u origin HEAD`.

Stacked branch: run both safety checks in *Stacked PRs → Line up the lower branches* first, then `gh stack push`.

If a PR already exists for the branch, pushing updated it; skip creation.

## 7. Visual evidence (best-effort)

`ext: screenshots`: run `overbridge ext ship-pr screenshots` first (how to run the UI and capture it).

A change with a visual surface owes a screenshot. Never block the PR on it.

- **Skip, and say why**, when the diff touches no markup, style, story, icon or asset: pure test, type, config, docs and CI changes have nothing to show.
- Find how the repo runs its UI: the `apps` block in `overbridge.yml` if it has one, otherwise its `CLAUDE.md`, README or `package.json` scripts. Prefer a component catalogue (Storybook and the like) when a story covers the changed component: no login, faster boot, a stable URL a reviewer can open. Fall back to the app for a route, a page layout or a flow no story renders.
- Never invent a port. Use the repo's configured ports. If they are taken by someone else's server, say so and skip.
- Start the server in the background and poll until it answers, instead of sleeping. If it exits or never answers, read its output and use that as the reason in the summary.
- Capture with the browser tooling you have (the `claude-in-chrome` skill, or `playwright-cli` if installed). **One image per distinct visual change**, framed on the changed element, not a whole busy page. Before/after when existing UI changed: render the "before" from a throwaway `git worktree add <tmp> origin/<base> --detach` (the stack base for a stacked PR, never a layer below you), never by stashing or switching branches. Drive the UI into the state the change affects (error, empty, hover, disabled), and capture both themes when colours or tokens changed.
- **Login.** Never drive an SSO or MFA flow yourself and never read credentials out of `.env` files. If the app needs a session, ask the user to sign in once, in their own browser tab or the headed window you opened, and wait. If they are away, skip and say so. A saved storage state holds a live session cookie: keep it outside any repo and never paste it anywhere.
- **Attach.** There is no stable public upload API for PR images. Leave the `<!-- screenshots -->` marker in the body, create the PR, then name the PNGs' paths in the final summary so the user can drag them into the description, and remove the marker from the body yourself so no placeholder is left. Do not wait for them. If you have an upload snippet from the repo's own conventions, use it verbatim and read the body back to confirm no URL is `null`.
- Stop the server, close the browser session (only tabs you opened), delete the PNGs after upload, and **never `git add` a screenshot**. A stray `.png` in `git status` is removed before any later commit.

## 8. Fill the PR body

`ext: pr-body`: run `overbridge ext ship-pr pr-body` first (the PR body and title).

Use **`TEMPLATE.md` in this skill's directory** in every repo, in place of the repo's own `PULL_REQUEST_TEMPLATE.md`, unless the repo's `CLAUDE.md` says otherwise. Read it and follow its filling rules:

1. The visible items: the optional **Feature flag**, then **User-facing change**, **Functional change**, **Gaps**, and on a performance PR **Performance** with a benchmark table that is never collapsed.
2. Screenshots, visible, with the `<!-- screenshots -->` marker until the images exist.
3. Collapsed blocks, each dropped when empty: **Acceptance criteria**, **Testing**, **Related items**, **Dependencies** (only when a manifest changed; `update-library` supplies its own filled template for it).

The body summarises in `**Label:** value` lines with no `##` headings and never restates the code. It never names a personal skill, agent or review tool. Strip every `<…>` placeholder before publishing; the screenshots marker is the one exception.

## 9. Create the PR

1. Title in the repo's convention, under 80 characters.
2. Create it as a **draft** unless the user says it is ready:
   ```sh
   gh pr create --draft --title "<title>" --body "$(cat <<'EOF'
   <filled template>
   EOF
   )"
   ```
   If the session's instructions specify a PR-body footer, end the body with exactly that line.

   Create it without asking when you own the repo (see *Run to completion*). A stacked branch uses `gh stack submit` instead (see *Stacked PRs*).
3. **Record it.** `overbridge pr <repo>` so `overbridge status` and claim checks know the PR belongs to this workspace. On a stack, run it after submitting and after moving between layers.
4. **Request a Copilot review.** The reviewer is the bot `copilot-pull-request-reviewer[bot]`; `--reviewer` does not accept it, so use the REST API:
   ```sh
   read -r owner repo <<<"$(gh repo view --json owner,name --jq '.owner.login + " " + .name')"
   pr=$(gh pr view --json number --jq '.number')
   gh api -X POST "repos/$owner/$repo/pulls/$pr/requested_reviewers" -f 'reviewers[]=copilot-pull-request-reviewer[bot]'
   ```
   A 404 or "Reviews may only be requested from collaborators" means Copilot review is not enabled for the repo: note it and carry on. An account out of Copilot premium requests gets a 201 and no review: if the PR timeline shows no `review_requested` event for `Copilot` after the request, say the quota may be spent and skip the wait in step 11.
5. **Request a CodeRabbit review, when the repo uses CodeRabbit.** CodeRabbit skips draft PRs on its own, so a draft gets no review unless asked. The repo uses it when it has a `.coderabbit.yaml` or `.coderabbit.yml`, or a `coderabbitai` comment or check shows up on the PR within about a minute of opening it. Unless that config sets `drafts: true` under `reviews.auto_review` (then it reviews drafts itself), ask for the review with a comment:
   ```sh
   gh pr comment "$pr" --body "@coderabbitai review"
   ```
   Do it again after every later push to a draft PR: its pushes are not reviewed automatically either. If CodeRabbit answers that it is rate limited (a comment containing `rate limited by coderabbit.ai`, which says when it is back), note it and skip its wait in step 11; that is quota, not a failure.
6. Attach screenshots now if there are any (step 7), then read the body back (`gh pr view "$pr" --json body`) and confirm what landed matches what you sent. A write can silently drop a section.
7. If the repo has a counterpart PR in another repo (a frontend change and its e2e tests, an API and its client), name each in the other's description at the very top, with the full `owner/repo#number` form, and say which one carries the change. Keep both honest as things move.
8. Report the PR as a link and confirm: draft or ready, base branch, Copilot and CodeRabbit reviews requested (or why not), and what the screenshots ended up as (N images, or the reason there are none).

## 10. Wait for a green build

The PR isn't done until CI passes. The push already happened, so CI is running.

1. **Watch the checks, but not the human-approval gates.** A check that waits for a person (a policy or approval bot, a visual-review check) stays `pending` until someone acts, so `gh pr checks --watch` would hang. Identify such checks once, by name, tell the user which you are treating as gates, and poll a filtered view:
   ```sh
   GATES='policy-bot'     # regex of gate names for this repo, case-insensitive; extend it as you learn them
   gh pr checks <pr> --json name,bucket \
     | jq --arg g "$GATES" '[.[] | select((.name | ascii_downcase | test($g)) | not)]
           | {unfinished: (map(select(.bucket=="pending")) | map(.name)),
              failed:     (map(select(.bucket=="fail"))    | map(.name))}'
   ```
   (`bucket` is one of pass, fail, pending, skipping, cancel.) Re-poll every ~30s until `unfinished` is empty, then **return**: a still-pending gate does not block moving on. Hand the user the link of a pending gate (`gh pr checks <pr> --json name,link`) and say it needs their approval, not a rerun.
2. **If a check fails**, read why: `gh run view <run-id> --log-failed`.
3. **Classify each failure:**
   - **Caused by this branch** (merge conflict, type error, test failure from your change): fix it. For a branch behind its base, use the `merge-main` skill on a normal PR. On a stack use `gh stack sync`, never a plain rebase of one mid-stack branch. Commit, push, re-watch.
   - **Suspected flake** (infra timeout, network blip, known-intermittent test, passes on re-run): rerun only the failed job, **up to 2 times** per job: `gh run rerun <run-id> --failed` or `gh run rerun --job <job-id>`. Track a per-job count. After two reruns that still fail, stop and treat it as real: surface it rather than looping.
   - **Unrelated** (pre-existing breakage on the base, an outage affecting every PR): surface it to the user, don't chase it.
   An outage in a setup step (a 5xx while downloading a tool or action) is infrastructure: rerun it.
4. Re-watch after every fix or rerun, and after every later push to the PR (review fixes, a merge of main, a rebase). Loop until every non-gate check is green, a failure is confirmed real and unfixable, or the rerun budget is spent.
5. **Never declare the build green without confirming on GitHub that the checks passed.** Never rerun an approval gate hoping it turns green.

## 11. Wait for Copilot and CodeRabbit, then resolve feedback

1. Poll until each reviewer's review lands, every ~20 to 30s. Copilot usually takes a few minutes, CodeRabbit up to about ten:
   ```sh
   gh api "repos/$owner/$repo/pulls/$pr/reviews" \
     --jq '.[] | select(.user.login | test("copilot|coderabbit"; "i")) | {who: .user.login, state, at: .submitted_at}'
   gh pr checks "$pr" --json name,bucket --jq '.[] | select(.name | test("coderabbit"; "i"))'
   ```
   A reviewer is done when it has a review newer than the last push, or (CodeRabbit) its `CodeRabbit` check has finished. Skip a reviewer when step 9 found it is not enabled, unavailable or out of quota, or when nothing appears after a reasonable wait: say so and move on.
2. Invoke the `resolve-feedback` skill on the PR. It treats Copilot and CodeRabbit the same way. On a stack it must keep the chain intact: `gh stack sync`, or a manual rebase onto `origin/$BASE_BRANCH`, never the default branch.
3. **Go round again while the PR is a draft.** Fixes are pushed, and a draft's pushes are not reviewed automatically, so when the repo uses CodeRabbit post `@coderabbitai review` again (step 9.5) and wait for the review that follows. Repeat steps 1 and 2 until no bot thread is left unresolved and no review is still in flight, at most three rounds; then report what is left.
4. When it finishes, confirm the build is still green (step 10's rules) before reporting done.

## 12. Link the item

`ext: post-pr`: run `overbridge ext ship-pr post-pr` first (what to do with the item once the PR is open).

Closing the loop on the item is part of shipping. `overbridge item` has no transition command, so:

- **GitHub**: a closing keyword (`Closes #<n>`) on the last line of the PR body closes the issue on merge. Add it unless the PR is one slice of a larger item (then `Refs #<n>`).
- **Jira**: the key in the PR title or the commit body links it. Moving the ticket to review is the Jira integration's or the user's job; offer `jira issue move <key> "<status>"` only when the user asks for it, and look up the status names first rather than guessing.

## Stacked PRs

`gh stack` owns the mechanics: branch chaining, base targeting, force-safe pushes and the stack relationship GitHub renders. A PR whose base field is set by hand *looks* stacked but isn't tracked, so `gh stack view`, `sync` and `rebase` cannot help it later. **Finishing with an untracked base is not done.** Check the extension first:

```sh
gh extension list | rg -q 'github/gh-stack' && echo ok || echo MISSING
```

If it is missing, tell the user to run `gh extension install github/gh-stack` (it needs their GitHub auth) and stop. Do not install it silently, and do not fall back to a hand-set `--base` unless the user insists; if they do, adopt it afterwards with `gh stack init <bottom> <top>` and `gh stack link <bottom-pr> <top-pr>`.

Use the `gh-stack` skill for the exact non-interactive flags, the rebase and conflict flow, and merging. This section adds what overbridge needs on top.

**A claim covers the whole stack.** `overbridge checkout <repo> '#<pr>'` pulls an existing stack and claims every layer. Never `gh stack checkout` or `gh stack trunk`: both are blocked. Run `overbridge pr <repo>` after submitting and after moving between layers. A branch or PR claimed by another workspace cannot be taken: if `overbridge checkout` refuses, stop and tell the user.

"Base" below means the branch the PR targets, **not the default branch**. Resolve a PR number or URL to a branch first:

```sh
BASE_BRANCH=$(gh pr view <number|url> --json headRefName --jq .headRefName)
```

### Pick the shape

- **A. The work already has its own branch and usually a PR** ("stack my PR on X", "restack onto X"). Do not create a branch; adopt what exists.
  ```sh
  # 1. Put the head's own commits on top of the base. If the base was squash-merged or rewritten, a plain rebase
  #    replays commits already in it as duplicates, so replay only your own:
  git rebase --onto "$BASE_BRANCH" <sha-the-head-branched-from>
  # 2. Track the chain locally, bottom to top (run the lower-branch check below first).
  gh stack init "$BASE_BRANCH" "<head-branch>"
  # 3. Establish it on GitHub: link takes PR numbers or URLs bottom to top and reuses the open PRs.
  gh stack link <base-pr> <head-pr>
  gh stack view
  ```
  The commits and PRs exist already, so skip commit, template and create. Push (`gh stack push`), then do the build and review steps. Re-run the checks on each layer: the base moved under them. Update a PR body only where it is now wrong. GitHub renders the stack itself, so a hand-written "stacked on #X" note duplicates it and goes stale.
- **B. The changes are not on their own branch yet.** The claimed branch the work sits on becomes the base, and a new head branch holds the changes.
  1. `BASE_BRANCH=$(git branch --show-current)`. If it is the default branch, this is not a stacked PR: say so and carry on with a normal PR (or confirm which branch they actually want as the base). The base must exist on origin (`git ls-remote --exit-code --heads origin "$BASE_BRANCH"`); push it first if not, since a stacked PR cannot target a branch that isn't on the remote.
  2. Name the head branch in the repo's convention (`<type>/<id>-<slug>`); ask when you cannot infer one, offering `<BASE_BRANCH>-followup`. Create it with `gh stack add "<head-branch>"`, which chains it on the current base and carries uncommitted changes across. If the base isn't in a stack yet, `gh stack link <its PR url|number>` adopts it first. Then `overbridge pr <repo>` records the new layer.
  3. Never commit the stacked changes onto the base itself: that yields an empty-diff PR.

### Line up the lower branches with origin before any `gh stack` write

`gh stack init` and `gh stack link` adopt each local branch as it stands, and `gh stack push` force-pushes every branch. If a local copy of a lower branch is behind origin, the push overwrites the real branch with the stale one, and GitHub then sees a PR with no commits and closes it. Before `init`, `link`, `add`, `push` or `submit`, fetch and line up every branch **below** the head, bottom first:

```sh
git fetch origin
for b in <bottom-branch> <next-branch-up>; do   # every layer below the head, bottom first
  git rev-parse -q --verify "origin/$b" >/dev/null || continue   # not on origin yet: nothing to lose
  if ! git show-ref -q --verify "refs/heads/$b"; then
    git branch "$b" "origin/$b"                                   # no local copy: take origin's
  elif git merge-base --is-ancestor "$b" "origin/$b"; then
    git branch -f "$b" "origin/$b"                                # behind or equal: move it to origin
  elif ! git merge-base --is-ancestor "origin/$b" "$b"; then
    echo "STOP: $b and origin/$b have diverged"; break            # ask the user which side is right
  fi                                                              # ahead: unpushed local work, keep it
done
```

Leave the head out: after `git rebase --onto` it differs from origin on purpose. A lower branch that another workspace holds is not yours to move: `git branch -f` on a branch checked out elsewhere fails, which is the right outcome; stop and tell the user.

Then, right before `gh stack push`, confirm the push drops nothing from origin on any lower branch. This compares patches, not commit ids, so a branch that `gh stack rebase` or `sync` rewrote still passes:

```sh
for b in <every branch below the head>; do
  n=$(git cherry "$b" "origin/$b" 2>/dev/null | grep -c '^+')   # origin commits with no equal patch in $b
  [ "$n" -eq 0 ] || { echo "STOP: pushing $b would drop $n commits from origin/$b"; break; }
done
```

If either check prints `STOP`, don't push. Show the user what it found. A lower branch already overwritten has its old head in `git reflog show origin/<branch>`; restoring it needs `git push --force-with-lease=<branch>:<bad-sha> origin <good-sha>:refs/heads/<branch>`, then `git branch -f <branch> <good-sha>` and `gh pr reopen <pr>`. Ask before running any of it.

### What differs from a normal PR

- **Submit** with `gh stack submit --auto` (no confirmation needed on a repo you own): it pushes every layer, opens or updates one PR per layer with the right base chaining, and injects the navigation table. The PR must end up a **draft** based on `$BASE_BRANCH`; if it opened ready, `gh pr ready --undo <pr>`. Run `gh stack view`: it must show the chain `<default> ← base ← head`. A PR with only a base field is not done.
- **Scope every section to this layer.** The change items, the AC table and the Testing block cover only `git diff "$BASE_BRANCH"...HEAD`. An AC delivered by another layer gets a row `Delivered in <PR link>`, not a claim or a drop. A planned test condition proven in another layer belongs in that layer's PR, not this one's **Gaps**.
- **Related items** includes the base PR's item when it differs, labelled **Stacked on**.
- **Screenshots**: the "before" is the stack base (`origin/$BASE_BRANCH`), never the default branch: a diff against the default branch credits this PR with the layers below it. Screenshot the layer that owns the visual change; a layer that only moves code gets a written reason, not a duplicate image.
- **Counterpart-PR links** go above the stack navigation table, and only the layer carrying the change needs one.
- **Merge conflicts or behind-base**: `gh stack sync` (fetches, rebases the whole stack onto its bases, updates PR targets; never orphans upper branches). Never plain-`git rebase` one mid-stack branch; it orphans the ones above. Push with `gh stack push`.
- **When the base's PR merges**, GitHub retargets this one to the default branch. Check how it merged: a squash-merged base means its commits are not ancestors of the default branch, so `gh stack sync` (or `git rebase --onto origin/<default> <old-base-head>`) drops that layer cleanly, where a plain rebase replays it as duplicates. Tell the user the stack collapses on merge.
- **Rebase the whole stack onto the latest default branch** with `gh stack rebase`. Merging into it is `merge-main`'s job for a single branch only: on a stack, do not use it.
- Drive the layers **bottom PR first**: it is the one that can merge. Each layer still needs its own green build and its own Copilot and CodeRabbit review and resolution.

## Splitting an oversized branch

Turn one big branch into a stack of smaller PRs, one slice per layer. This rewrites history into new branches, but the `-presplit-backup` branch keeps it recoverable, so state the plan and build it without waiting; stop to ask only when a slice cannot be drawn at file boundaries (a hunk-level split) or the user's own plan conflicts with the dependency order. The `gh-stack` skill covers the generic mechanics; this section is the overbridge-specific safety net.

1. **Preconditions.** `gh stack` installed (see above). A clean tree: commit uncommitted work onto the source branch first, never split a dirty tree. Then:
   ```sh
   SRC=$(git branch --show-current)
   BASE_REF=origin/<default>          # or origin/<lower-stack-branch> when SRC is already part of a stack
   git fetch origin --quiet
   git diff --merge-base "$BASE_REF" HEAD --stat
   git branch -f "${SRC}-presplit-backup" HEAD
   ```
   Tell the user the backup branch name. Keep it until they say the stack is good.
2. **Get the plan.** Use the user's plan if they gave one (layers and which files go where). Otherwise run `persona-pr-size` from the `overbridge-review` plugin if it is installed: it is not model-invocable, so read its `SKILL.md` and follow it, or hand its path to a subagent, to propose bottom→top slices with branch names, per-slice file scope and dependency order. Without that plugin, propose the layout yourself from the same rules: groundwork (types, helpers, refactors) at the bottom, behaviour on top, a lower layer never importing from a higher one.
3. **Normalise to file boundaries.** Each layer owns a **disjoint set of whole files**. A plan that needs two layers to touch the same file is a hunk-level split: keep those files together in one layer, or tell the user that layer needs manual `git add -p` staging. Every changed file lands in exactly one layer, verified against `git diff --merge-base "$BASE_REF" HEAD --name-only`.
4. **State** the layers, branch names, file→layer map and the resulting diagram, then build.
5. **Build bottom→top.** Check paths out of the source with `git restore`, which the guard allows, not `git checkout <ref> -- <path>`. `git restore --source` cannot record a deletion, so this helper removes what the source deleted:
   ```sh
   bring_in() {
     for f in "$@"; do
       if git cat-file -e "$SRC:$f" 2>/dev/null; then
         git restore --source "$SRC" --staged --worktree -- "$f" || { echo "bring_in: failed to restore $f" >&2; return 1; }
       else
         git rm -q --ignore-unmatch -- "$f" || { echo "bring_in: failed to remove $f" >&2; return 1; }
       fi
     done
   }
   ```
   Renames are a delete plus an add: put both paths in the same layer.
   ```sh
   overbridge checkout <repo> "<L1-branch>"     # new branch from origin/<default>; the claim moves from SRC to L1
   gh stack init                                 # adopt L1 as the bottom of a new stack (see the gh-stack skill for flags)
   bring_in <L1 files>
   git commit -m "<type>(<scope>): <L1 summary>"
   gh stack add "<L2-branch>"
   bring_in <L2 files>
   git commit -m "<type>(<scope>): <L2 summary>"
   ```
   Repeat to the top. When the source was already part of a stack, build on `origin/<lower-stack-branch>` instead. A hunk-level layer (only if unavoidable): `bring_in <file>`, `git add -p <file>`, commit, then `git restore -- <file>` to discard the unstaged hunks before `gh stack add`; the layer that owns them runs `bring_in` again and takes the whole file.
6. **Verify.** `gh stack view` shows the chain, and no lower layer imports a symbol a higher layer defines (if one does, the plan is inverted: re-slice). Then the top of the stack must have the same tree as the source:
   ```sh
   git diff "<Ln-branch>" "$SRC" --stat     # expect empty
   ```
   Non-empty means a file was missed or misassigned. Fix the layer before submitting; never open PRs on an incomplete split.
7. **Submit.** Run the lower-branch checks from *Stacked PRs* first when the stack sits on an existing branch, then `gh stack push` and `gh stack submit --auto`. Fill every layer's description from the template, scoped to that layer, so none is left as a bare commit subject. Request Copilot (step 9.4) and, where the repo uses it, CodeRabbit (step 9.5) on **every** PR in the stack, once per PR. Run `overbridge pr <repo>`. Report the bottom→top list of PR links, which is the base of which, and that the bottom PR merges first.
8. Then drive each PR through steps 10 and 11, bottom first.

## Rules

- **Draft PRs, and request a Copilot review and, where the repo uses CodeRabbit, a CodeRabbit review** (by comment, since it skips drafts) on every PR. Only open one ready when the user says so.
- **Attribution**: end commits and PR bodies with exactly the attribution lines the session's instructions specify, and add none if none are specified. Never invent one. Always commit with the user's git identity.
- **Always use `TEMPLATE.md`** for the PR body, unless the repo's `CLAUDE.md` says otherwise. Tick the checkboxes that match the real changes.
- **Never name a personal skill, agent or review tool in a PR body or title.** Describe outcomes, not the tooling that produced them.
- **Describe the change, not the process of making it.** The body says what changed and why, in the fewest words that carry it. Never narrate your own investigation and never revise a claim in place: if an earlier reading was wrong, publish the correct one and delete the wrong one. No "I first thought", "turned out to be", "worth flagging". When the body is edited after review feedback or a red build, rewrite the affected section so it reads as though it were always correct.
- **Cut anything that would not change a reviewer's decision**: long verbatim changelogs, notes about which local check caught what, commentary on how the work went. Keep the diff's intent, the callsites, the risks and the evidence.
- **Never commit a screenshot.** Never paste an empty or `null` attachment URL into a body. Never drive an SSO or MFA login yourself.
- **Never declare the build green without confirming the checks passed on GitHub.** Fix branch-caused failures, rerun suspected flakes at most twice per job, surface unrelated ones. The final summary names every check that is not green.
- **Always wait for Copilot's and CodeRabbit's reviews and resolve them** with `resolve-feedback` before calling a PR done, unless a reviewer is unavailable (say which, and why).
- **A base field is not a stack.** Before reporting a stacked PR done, `gh stack view` must show the chain.
- **Never `gh stack push` over a stale lower branch**, and never plain-rebase one mid-stack branch.
- **State the split plan, then build it**; keep the `-presplit-backup` branch until the user says otherwise, and require an identical tree at the top of the stack.
- Do not ask before committing, pushing, creating the PR or submitting a stack on a repo you own. Ask only on someone else's repo, or when the input is ambiguous.
- Never end the turn with a to-do list ("not done yet: submit the stack, write the descriptions, take screenshots"). Do those steps; a skipped one goes in the summary with its reason.

## Humanizer pass

`ext: prose`: run `overbridge ext ship-pr prose` first (passes over the text you publish).

If the `humanizer` skill is installed, run it over the PR title and description of every PR you write, and publish the result rather than your draft. This applies to edits as well as new text. After the write, read the text back from the API and confirm what landed matches what you sent.

Commit messages and code comments are exempt.
