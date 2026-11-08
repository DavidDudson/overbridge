---
name: resolve-feedback
description: Action PR review feedback. Fetches review comments from GitHub, applies the clear fixes, asks about the ambiguous ones, replies to and resolves threads only for automated reviewers (Copilot and other bots) and never for humans, syncs with the default branch, checks CI is green and prints a summary table. Use when the user says "resolve feedback", "address review comments", "check PR comments", "handle the Copilot review", or passes a PR with reviews on it.
---

# Resolve review feedback

## Hard rules on replies and resolution (read first)

- Never reply to a human reviewer's comment. Fix the code and leave the thread alone: the human reads
  the diff and replies or resolves it themselves.
- Never resolve a human reviewer's thread.
- Automated reviewers (GitHub Copilot and other bots) are the only threads you may reply to or resolve.
  Start every bot reply with `Claude says: `.
- Tell the two apart by the comment author: `.user.type == "Bot"`, or a login ending `[bot]`, is a bot.
  Anything else is a human. If unsure, treat it as human.
- Never resolve a thread you did not actually fix.

## Arguments

An optional PR number. Without one, use the current branch's PR:

```sh
gh pr list --head "$(git branch --show-current)" --json number,url --jq '.[0]'
```

## 0. Sync first

`main` moves while you work, so trust nothing local. Fetch the default branch on its own, then ask
GitHub, which is authoritative:

```sh
git fetch origin <default-branch>
gh pr view <n> --json mergeable,mergeStateStatus --jq '"mergeable: \(.mergeable)  state: \(.mergeStateStatus)"'
git rev-list --left-right --count origin/<default-branch>...HEAD    # "<behind> <ahead>"
```

`CONFLICTING` or `DIRTY` means real conflicts: resolve them now with `merge-main` (or `rebase-main`
when the user wants linear history), before reading any comments. `BLOCKED` with no conflicts is just
CI or approvals gating.

## 1. Fetch the comments

Review bodies, inline comments (keep each `id` for replies) and thread node ids (needed to resolve):

```sh
gh api --paginate repos/{owner}/{repo}/pulls/<n>/reviews  --jq '.[] | {author: .user.login, type: .user.type, body}'
gh api --paginate repos/{owner}/{repo}/pulls/<n>/comments --jq '.[] | {id, path, line: (.line // .original_line), author: .user.login, type: .user.type, body, diff_hunk}'
gh api graphql --paginate -f query='
  query($owner:String!,$repo:String!,$pr:Int!,$endCursor:String){
    repository(owner:$owner,name:$repo){ pullRequest(number:$pr){
      reviewThreads(first:100,after:$endCursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ id isResolved comments(first:1){ nodes{ databaseId path } } } } } } }' \
  -f owner=<owner> -f repo=<repo> -F pr=<n> \
  --jq '.data.repository.pullRequest.reviewThreads.nodes[] | {threadId: .id, isResolved, commentId: .comments.nodes[0].databaseId, path: .comments.nodes[0].path}'
```

No comments: say so and stop.

## 2. Categorise each comment

Read the file at the referenced line and the code around it first. A comment read without its code is
easy to get wrong. Then put it in one bucket:

| Category | When | Action |
|---|---|---|
| Fix | Clearly correct, low-risk, unambiguous | Apply it |
| Ask | Has merit but is a judgement call: trade-off, scope, or the reviewer may be wrong | Put it to the user with your analysis and a recommendation |
| Dismiss | False positive, or misreads the wider design | Say briefly why. Do not change code |

Weigh the source: bots produce more false positives than people. Check any `suggestion` block against
the surrounding code before applying it.

## 3. Apply the fixes

Group related fixes. Then check them with the repo's own commands:

```sh
overbridge config get commands.typecheck
overbridge config get commands.test
```

An unset command means the repo has none. Run the smallest scope that covers the change.

Do not block on the Ask items. Apply the Fix items, push and watch CI (step 4), then list each Ask item in the summary with your analysis and recommendation. Apply one later if the user answers.

For each bot comment actually fixed (Fix items, and Ask items once the user has approved them), reply and resolve:

```sh
gh api -X POST "repos/<owner>/<repo>/pulls/<n>/comments/<commentId>/replies" -f body="Claude says: Resolved"
gh api graphql -f query='mutation($t:ID!){ resolveReviewThread(input:{threadId:$t}){ thread{ isResolved } } }' -f t=<threadId>
```

Do neither for Dismiss items, declined Ask items or any human thread.

## 4. Sync again and check CI

Re-fetch and recheck mergeability, since the default branch may have moved. If the branch is behind or
conflicting, use `merge-main` or `rebase-main`. On a `gh stack`, use `gh stack sync`, then `gh stack
push`: a plain rebase of one mid-stack branch orphans the layers above it.

Push, then read CI from GitHub rather than running the build locally. Do not use `gh pr checks
--watch`: a check waiting on a human approval stays pending forever and the watch never returns. Poll
instead and treat the build as settled once every other check has finished:

```sh
gh pr checks <n> --json name,bucket --jq '{unfinished: [.[]|select(.bucket=="pending")|.name], failed: [.[]|select(.bucket=="fail")|.name]}'
```

Repoll about every 30 seconds. A pending check that needs a person's approval does not block: tell the
user it is waiting on them. For a failure, read it with `gh run view <run-id> --log-failed`. Fix what
this branch caused, commit, push, and recheck. Rerun a flaky job (a 5xx downloading a tool in a setup
step) at most twice per job, as `ship-pr` step 10 does. Report failures from elsewhere (a broken
default branch, a job still failing after its reruns) instead of chasing them. Never call the build green without seeing the checks
pass on GitHub.

## 5. Summary

Print one table covering every comment:

```
| # | File | Feedback | Category | Action |
|---|------|----------|----------|--------|
| 1 | src/menu.ts:100 | Always emit on controlled open | Fix | Removed the guard; emit always fires |
| 2 | src/hooks.ts:33 | Missing accordion fields | Dismiss | False positive: rendered by the child |
```

Keep it short enough to scan without rereading the comments.

## 6. Review calibration (optional)

If the repo has review personas (`overbridge config get review.local-dir`, or the `overbridge-review`
plugin) and a human reviewer caught something the panel would have missed, or a Dismiss contradicts a
persona, propose one persona edit: name the persona, quote the comment and give the one-line change.
Weigh humans over bots, use only feedback from this PR, and apply nothing without the user's approval.
Skip this step when nothing maps cleanly.

## Prose

Run the `humanizer` skill over any PR description you rewrite. Bot replies, commit messages and code
comments are exempt. After writing, read the text back from the API and confirm what landed matches
what you sent.
