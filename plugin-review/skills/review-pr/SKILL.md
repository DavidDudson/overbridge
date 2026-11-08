---
name: review-pr
description: Check out an existing PR from any handle (a PR URL, PR number, work-item id such as an issue number or Jira key, or branch name) into this overbridge workspace, then run the full mob-review panel over its branch. Use when the user says "review-pr <thing>", "checkout and review this PR", "review ENG-123's PR", "/review-pr", or hands you a PR link/number/item/branch and wants it checked out and mob-reviewed.
---

# Review PR: checkout + mob-review

Resolve any handle that points at an open PR (**PR URL, PR number, work-item id, or branch name**), claim and check out its branch through `overbridge`, then delegate to the `mob-review` skill for the full review panel.

This workflow checks out and reviews. It does **not** resolve feedback, merge main, or touch CI.

On **someone else's** PR nothing is edited at all. On **your own** PR, `mob-review`'s Step 6 applies the small, clear-cut findings and commits them: that's its rule, not an exception this skill makes.

`mob-review` alone reviews the branch that is already checked out. This skill adds handle resolution and the claim in front of it.

## Guard: only inside a workspace

Confirm this session is bound to an overbridge workspace:

```sh
echo $OVERBRIDGE_NAME
overbridge status
```

If `OVERBRIDGE_NAME` is empty, **stop**. Do not clone, check out, or `cd` anywhere. Reply that `review-pr` must be run from a Claude session inside an overbridge workspace (`<root>/<ws>`), and name the current directory.

## Arguments

A single handle. Detect its kind:

- **PR URL**: matches `github.com/<owner>/<repo>/pull/<n>` → PR number is `<n>`; `<owner>/<repo>` is the repo.
- **PR number**: bare integer or `#123` → PR number directly.
- **Item id**: an issue number that isn't a PR, or a Jira-style key (`[A-Z]+-\d+`) → search PRs for it.
- **Branch name**: anything else → find the PR whose `headRefName` is that branch.

If no argument is given, ask for one before proceeding.

## Phase 1: Resolve handle → repo, branch and PR

Resolve with `gh` against an explicit repo. Take `<owner>/<repo>` from a PR URL; otherwise use the repo the session is in, and ask which repo when the session is in none and the user hasn't said. Every `gh` call takes `-R <owner>/<repo>`.

- **PR number / URL:**
  ```sh
  gh pr view <n> -R <owner>/<repo> --json number,title,headRefName,baseRefName,url,state
  ```
- **Item id:**
  ```sh
  gh pr list -R <owner>/<repo> --state open --search "<id>" --json number,title,headRefName,baseRefName,url,state
  ```
  If none, broaden with `--state all --search "<id> in:title,body"`. A match there may be `MERGED` or `CLOSED`: report that and ask before going on, since its branch may be gone.
- **Branch name:**
  ```sh
  gh pr list -R <owner>/<repo> --state open --head "<branch>" --json number,title,headRefName,baseRefName,url
  ```

Resolution rules:
- Exactly one PR → take its `headRefName`, `number`, `url`.
- Multiple → show them (title and link), ask which.
- None, but the branch exists on origin (`gh api repos/<owner>/<repo>/branches/<branch>` succeeds) → tell the user there's no PR; ask whether to check out and review the branch anyway or stop.
- Nothing found → report what was searched, stop.

Confirm the resolved repo, branch and PR back to the user.

## Phase 2: Claim and check out

Reviewing needs the branch in this workspace's working tree, and the claim is what keeps two workspaces off the same branch.

1. If the repo's worktree already exists here, check for uncommitted work:
   ```sh
   git status --porcelain
   ```
   If dirty, **stop and ask** before switching. Never blow away uncommitted work.
2. Claim and switch with `overbridge`, never `gh pr checkout`, `git switch` or `git checkout <branch>` (the guard blocks them):
   ```sh
   overbridge checkout <repo> '#<number>'     # a PR, stacked or not
   overbridge checkout <repo> <branch>        # a branch with no PR
   ```
   `<repo>` is the name registered in overbridge (`overbridge repo ls`), not `owner/repo`. If it isn't registered, ask the user before `overbridge repo add`.
3. **If `overbridge checkout` refuses** because another workspace holds the branch or PR, stop and tell the user which workspace holds it (`overbridge status --all`). Do not work around it.
4. `cd` into `<workspace>/<repo>` and run `git fetch origin --prune`.

Reviewing someone else's PR borrows the branch rather than owning it. When the review is done and you claimed it only for the review, `overbridge release <repo>` so the claim goes back to the pool. Keep the claim when the PR is yours.

No hard reset, no merge: mob-review diffs against `origin/main` (or the stack base) itself.

## Phase 3: Run the panel

Invoke the **`mob-review`** skill against the checked-out branch. It computes the diff vs `origin/main` (or the base branch of a stacked PR), selects the panel from `review.personas`/`review.exclude` in the repo's `overbridge.yml` (or by diff-signal guards when unset), spawns the in-scope reviewers in parallel, aggregates, and reports once via `ReportFindings` plus the coverage table.

## Phase 4: Report

The mob-review report is the output. Add a one-line header naming the handle given → the repo, branch and PR it resolved to (title and link), so the user sees what was reviewed.

## Anti-patterns to avoid

- **Don't** hard-reset or merge main: leave the branch exactly as checked out. (Applying `mob-review`'s small findings on your own branch is fine; rewriting or moving history is not.)
- **Don't** resolve or reply to PR feedback: that is the `resolve-feedback` skill's job, not this one.
- **Don't** re-implement the panel: delegate to `mob-review`; this skill only adds handle resolution and the claim.
- **Don't** switch branches over a dirty tree without asking.
- **Don't** bypass the claim with `gh pr checkout` or `git switch`.
