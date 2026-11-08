---
name: pickup
description: Pick up an open PR from any handle (a PR URL, PR number, work item id or branch name), claim its branch in this workspace, sync it with the remote, merge the latest default branch, resolve the review feedback and confirm the build is green. Use when the user says "pickup <thing>", "pick up this PR", "get on <branch>", "jump on 123's PR", or hands you a PR link, number, item id or branch and wants it cleaned up.
---

# Pick up a PR

Take whatever handle the user has, resolve it to one branch and PR, make the local branch match the
remote, bring it up to date, deal with the review feedback and check CI.

For only claiming a branch or PR without the clean-up, use the `workspace` skill.

## Arguments

One handle. Detect its kind:

- **PR URL**: `github.com/<owner>/<repo>/pull/<n>`.
- **PR number**: `123` or `#123`.
- **Item id**: a key like `ENG-123`, when the repo's `project-management.name` is `jira`
  (`overbridge config get project-management.name`). Search open PRs for it. A bare number is a PR
  number, even on a Jira repo, unless the user says otherwise.
- **Branch name**: anything else.

No argument: ask for one.

## 1. Resolve to a branch and PR

The repo comes from the URL, or from the user. A bare number, id or branch needs a repo: if you cannot
tell, ask. Use `-R <owner>/<repo>` on every `gh` call.

```sh
gh pr view <n> -R <owner>/<repo> --json number,headRefName,baseRefName,url,title,state
gh pr list -R <owner>/<repo> --state open --search "<id>" --json number,headRefName,baseRefName,url,title,state
gh pr list -R <owner>/<repo> --state open --head "<branch>" --json number,headRefName,baseRefName,url,title
```

- Exactly one open PR: take it.
- More than one: list them and ask which.
- None open: widen with `--state all`. A merged or closed match means its branch may be gone: say so
  and ask before going on.
- A fork PR lands on a local branch named `pr-<n>`: say so.

Show the title, branch and URL, and what you are about to do.

## 2. Claim and check out

Only through `overbridge`, never `git switch`, `git checkout <branch>` or `gh pr checkout`:

```sh
overbridge checkout <repo> '#<n>'      # or: overbridge checkout <repo> <branch>
overbridge status                      # confirm the claim and the head
```

If the claim is refused because another workspace holds the branch, stop and tell the user which one.
A stacked PR pulls its whole stack. Say so, and treat the rest of this skill as running on the layer
you were asked for.

## 3. Match the remote

```sh
git fetch origin <branch>
git status -sb
git rev-list --left-right --count origin/<branch>...HEAD     # "<behind> <ahead>"
```

- Behind only: fast-forward with `git merge --ff-only origin/<branch>`.
- Ahead only: leave it. Those are unpushed commits. Tell the user.
- Both: the local branch has diverged. Show `git log --oneline origin/<branch>..HEAD` and ask whether to
  rebase onto the remote or reset. Never reset without asking.
- Dirty tree: stop and ask. Do not stash for the user.

## 4. Bring it up to date

Run `merge-main`, or `rebase-main` if the user wants linear history or the branch is a stack (then it
is `gh stack sync`). Skip it when `git log --oneline HEAD..origin/<default>` is empty.

## 5. Review feedback

Run `resolve-feedback` on the PR. It also confirms mergeability and CI. If the PR has no review
comments it stops after a short note, which is fine.

## 6. Watch CI

Anything pushed in steps 4 and 5 starts CI again. Watch it as `ship-pr` step 10 does: poll the checks,
read each failure's log, fix what this branch caused, push, and watch again. Do not report done on a
red or still-running build.

## 7. Report

One short block: PR title and URL, branch, how it was brought up to date, what was done with feedback,
and the CI status. List anything that needs the user: a human thread to answer, an approval gate, a
failure that is not from this branch.
