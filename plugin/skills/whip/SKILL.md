---
name: whip
description: From the orchestrator (the overbridge root tab), find every workspace that still has work outstanding (a draft PR, a PR conflicting with main, review feedback or red CI, uncommitted changes, commits with no PR, an item not yet shipped) and send its Claude session a tailored "continue" message, skipping workspaces that are done (PR mergeable and awaiting merge, branch merged, sitting on the default branch with nothing changed) and detached ones with no claim, then print a table of who was sent what and who was skipped and why. Use when the user says "whip", "whip the workspaces", "tell every tab to continue", "nudge everyone", "send continue to all", or invokes /whip. Pass `--dry-run` to print the table without sending. Runs only in the orchestrator, never inside a workspace.
requires: gh-stack
---

# Whip

> Prerequisite: the `gh-stack` skill. Run `overbridge prereqs` first; if it fails, stop and tell the user to install it.

Send a plain "continue" to every workspace Claude that still has something to finish. The orchestrator
only coordinates, so this skill reads git and GitHub, decides, and messages. It changes nothing itself.

## Where it runs

The orchestrator: `$OVERBRIDGE_TAB` is set and `$OVERBRIDGE_NAME` is empty, and `overbridge whoami` names
no workspace. Inside a workspace the guard blocks the other workspaces, so say so and stop.

The orchestrator guard allows single commands and commands chained with `;`, `&&` or `|`. It blocks
shell loops (`for`, `while`, `xargs`), command substitution and redirects to files. So query **once per
repo**, not once per workspace, and chain the few per-worktree `git` reads with `;` in one Bash call. Never
try to work around the guard.

## Arguments

- `--dry-run`: build and print the table, send nothing.

## 1. Inventory

```sh
overbridge sync                      # fetch every bare repo, so origin/<default> is current
overbridge status --all --json       # ws, repo, branch (claim), pr, head, dirty, stack
overbridge repo ls                   # repo name → URL; take OWNER/REPO from the URL
```

Then call `ListAgents`. A workspace's session row is named for the workspace, sometimes with a two-character
suffix: `ws5-37`, `trim-initial-web-bundle`, `gh-stack-support-d2`. Match each workspace to its rows by
name (exact, or name plus `-<two hex chars>`). Several rows for one workspace are separate sessions: pick
the one started most recently, and note the others.

## 2. Query each repo once

For each repo in `overbridge repo ls` that any workspace claims, one `gh` call for its open PRs and one
for the recently merged ones. Use `-R OWNER/REPO` on both.

```sh
gh pr list -R OWNER/REPO --state open --limit 200 \
  --json number,title,url,headRefName,baseRefName,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,reviews,comments,updatedAt
gh pr list -R OWNER/REPO --state merged --limit 100 --json number,title,headRefName,mergedAt
gh repo view -R OWNER/REPO --json defaultBranchRef -q .defaultBranchRef.name
```

Pipe through `jq` to shrink `statusCheckRollup` to the worst conclusion (`FAILURE`/`ERROR`/`CANCELLED`/
`TIMED_OUT` = red, any `PENDING`/`IN_PROGRESS`/`QUEUED` = running, else green) and `reviews` and
`comments` to the newest one from someone who is not the PR author.

Then, for every claimed worktree, the git reads, chained with `;` in one call per repo (one `git -C` per
worktree):

```sh
git -C <root>/<ws>/<repo> rev-parse --abbrev-ref HEAD
git -C <root>/<ws>/<repo> log --oneline origin/<default>..HEAD | wc -l
git -C <root>/<ws>/<repo> log --oneline @{u}..HEAD 2>/dev/null | wc -l
git -C <root>/<ws>/<repo> log -1 --format=%cI
```

Put each line on its own line, or join them with `;`. Don't use `\` line continuations: the guard reads the
backslash as part of a word. `git rev-list` is not on the guard's read list, so count with `log | wc -l`.

- `HEAD` prints `HEAD`: the worktree is detached.
- The first count is commits not on the default branch; the second is commits not pushed (no upstream at all
  means everything is unpushed).
- The commit date is compared with the newest review or comment to tell new feedback from feedback the
  branch has already answered.

Stacked claims (`stack` set in the status): each layer is its own PR. Judge every open layer; the workspace
is outstanding if any layer is.

## 3. Classify each workspace

Go through every workspace in the status. Decide **outstanding** or **done**, and record one short reason.
The first match wins, checked in this order:

**Skip (done or nothing to send):**

| condition | reason |
| --- | --- |
| no repos, or every claim is `-` and no worktree is dirty | detached, no claim |
| claim is the default branch and the worktree is clean | on main, no changes |
| the claimed branch's PR is merged and the worktree is clean, nothing unpushed | merged |
| every open PR is not a draft, `mergeable` is `MERGEABLE`, CI green, no `CHANGES_REQUESTED`, no feedback newer than the head commit, worktree clean, nothing unpushed | mergeable, awaiting merge |
| no session row matched in `ListAgents` | no session (say `overbridge tab <ws>` reopens it) |

**Send (outstanding):** any of these, listed in the message in this order.

| condition | what to say |
| --- | --- |
| open PR `isDraft` | PR #n "title" is still a draft |
| `mergeable` is `CONFLICTING` or `mergeStateStatus` is `DIRTY` | PR #n conflicts with `<default>` |
| `reviewDecision` is `CHANGES_REQUESTED`, or a review or comment from someone else is newer than the head commit | PR #n has review feedback newer than the last push |
| CI worst conclusion is red | PR #n has a red build |
| worktree dirty | uncommitted changes in `<repo>` |
| commits ahead of `origin/<default>` or unpushed, and no open PR for the branch | commits on `<branch>` with no PR |
| claim is an item branch (anything but the default branch) with no open or merged PR and no commits ahead | item not yet shipped on `<branch>` |

CI still running with nothing else wrong is neither: skip it with reason "CI running". A PR with
`mergeable` `UNKNOWN` is GitHub still computing; treat it as mergeable for this pass and say so in the
table.

A workspace whose matched session is `busy` is still sent to: the message queues until its turn ends.
Note `busy` in the table.

## 4. Send

With `--dry-run`, go to step 5. Otherwise one `SendMessage` per outstanding workspace, to the matched
session row's name. The message is a plain continue. It names what is outstanding and nothing else:

```
Continue. Outstanding in <ws>:
- <one line per finding from step 3, with the PR title and number, the branch, the repo>

Carry on from your handoff if you have one (`read-handoff` after a clear), otherwise from where you are.
Don't stop to confirm reversible steps. Stop and say so only when something needs the user: a human review
thread to answer, a decision the handoff left open, or a failure that is not from this branch.
```

Keep it to that. Never tell a session to undraft, mark ready, merge, publish, release, force-push or
close anything: the auto-mode classifier in the workspace denies those, and a message that asks for them
stalls the session instead of moving it. Which of those steps a PR takes next is for the session and the
user, not the whip. Don't restate the handoff or guess at the fix.

## 5. Report

Print one table, every workspace in `overbridge status --all` order:

```
| ws | session | sent | reason |
| --- | --- | --- | --- |
| gh-app-12 | gh-app-12-3f (busy) | sent | PR #12 "Add thing" draft; dirty app |
| ws5 | ws5-e3 | skipped | mergeable, awaiting merge |
| ws7 | – | skipped | no session (overbridge tab ws7) |
```

`sent` is `sent`, `skipped`, or `dry-run` when nothing was sent. The reason is the step 3 reason, or
the findings for a sent one. Under the table, one line each for anything odd: a workspace with several
sessions (which one was used), a `mergeable` of `UNKNOWN`, a repo whose `gh` call failed.

## Rules

- Read-only. No `overbridge checkout`, `overbridge pr`, `gh pr edit`, `gh pr ready`, `gh pr merge`, and no
  git write. If a step seems to need one, it belongs to the workspace session, so put it in the message as
  a finding, not as an instruction.
- One `gh pr list` per repo, not per workspace. Ten workspaces on one repo is one call.
- Don't message the orchestrator itself, and don't message a session twice in one run.
- Don't message a done workspace "just in case". A session told to continue with nothing to do spends
  its context deciding that.
