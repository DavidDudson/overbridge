---
name: cleanup
description: From the orchestrator (the overbridge root tab), find the workspaces that `overbridge top sweep` leaves behind (a merged PR the sweep has not reached, an item whose PR merged from a differently named branch, a done item with nothing left to merge, an idle task workspace with no commits, an orphan folder that `overbridge status` does not list, a workspace named for a done item that holds another item's open PR, a workspace that was never started), report them in one table, and remove the safe ones with `overbridge rm` once the user confirms. Anything with uncommitted changes, unpushed commits, a stash, or stray files is listed as "review first" and never removed. Use when the user says "cleanup", "clean up the workspaces", "sweep workspaces", "what can I remove", "find stale workspaces", "find orphan workspaces", or invokes /cleanup. Pass `--dry-run` to print the report and remove nothing. Runs only in the orchestrator, never inside a workspace.
---

# Cleanup

`overbridge top sweep` removes a workspace only when every claimed branch has a recorded PR that has merged.
This skill covers the rest. `overbridge cleanup` does the checking and decides nothing on its own. You read its
report, ask the user, and run `overbridge rm`.

## Where it runs

The orchestrator: `$OVERBRIDGE_TAB` is set and `$OVERBRIDGE_NAME` is empty. Inside a workspace the guard blocks
`overbridge rm`, so say so and stop.

The orchestrator guard blocks shell loops, command substitution, and `git worktree remove`. You need none of
them: one `overbridge cleanup --json` call does the scan, and removals are `overbridge rm <name>` calls chained
with `;`. Never try to work around the guard.

## Arguments

- `--dry-run`: print the report, ask nothing, remove nothing.

## 1. Scan

```sh
overbridge cleanup --json
```

It fetches every repo, then prints one finding for each workspace and each orphan folder. It removes nothing.
Each finding has:

- **`ws`, `orphan`**: the workspace name, and whether it is a folder that `overbridge status` does not list.
- **`verdict`**: `remove`, `review`, `rebind`, `ask`, or `keep`.
- **`reason`**: why (see the table in step 2).
- **`summary`**: one line for the report.
- **`blockers`**: what removing it would lose or cut off: `uncommitted`, `unpushed`, `stash`, `stray-files`, or
  `session-active`, each with its `repo`.
- **`repos`**: for each repo, `claim`, `head`, `ahead` (commits the default branch lacks), `pr` (the claim's PR), and
  `itemPrs` (other PRs that name the item).
- **`item`, `named`**: the item the claimed branch names, and the item the workspace is named for, each with `status`
  (`open` or `done`).
- **`agent`**: the session's state.
- **`problems`**: reads that failed. A workspace with any is always `keep`.

## 2. Read the verdicts

| verdict | reason | what it means | what you do |
| --- | --- | --- | --- |
| `remove` | `merged` | every claimed PR has merged and the sweep has not run yet | offer to remove |
| `remove` | `merged-by-item` | no merged PR is recorded for the claimed branch, but a PR that names the item merged from another branch | offer to remove; show that PR's number and branch |
| `remove` | `item-done` | the item is done, no PR is open, and every commit is on a remote branch or in a merged PR | offer to remove |
| `remove` | `task-idle` | a `task/` branch with no PR and no commits, and the session is at rest | offer to remove |
| `remove` | `orphan` | a folder with registered worktrees that state does not list, with nothing unsaved | offer to remove |
| `review` | any of the above | it would be removed, but `blockers` is not empty | list under "review first"; never remove |
| `rebind` | `holds-other-item` | the workspace's own item is done, and it holds an open PR for another item | suggest the move in step 4; never remove |
| `ask` | `never-started` | no PR, no commits, nothing unsaved, session at rest, item not done | ask the user about each one |
| `keep` | `in-progress`, `unreadable` | work in progress, or a read failed | leave it; report `unreadable` ones with their `problems` |

The CLI's verdict is the most you may do. You may downgrade a `remove` to "review first" when something looks wrong (the
`summary` and the facts disagree, or a PR in `itemPrs` looks unrelated to the workspace). Never upgrade a
`review`, `rebind`, `ask`, or `keep` to a removal.

Stashes belong to the repo, not the worktree, and the scan counts only the ones made on the workspace's branch.
A stash made while detached cannot be matched to a workspace, so it is not counted.

## 3. Report

Print one table with every finding that is not `keep`, grouped in this order, then one line saying how many
workspaces were kept. Link each PR and item.

```
| ws | verdict | why | PR | item |
| --- | --- | --- | --- | --- |
| ENG-36603 | remove | PR merged from another branch | #3301 fix/ENG-36603-renamed | ENG-36603 (done) |
| ENG-37729 (orphan) | remove | folder not tracked by overbridge | none | none |
| ENG-37001 | review first | merged; uncommitted changes in portal | #3288 | ENG-37001 (done) |
| ENG-37559 | rebind | named for a done item, holds ENG-37558's open PR | #3290 | ENG-37559 (done) |
| ENG-37800 | ask | never started; item still open | none | ENG-37800 (open) |
```

For each "review first" row, say what to look at: the repo and the blocker (`git -C <root>/<ws>/<repo> status`,
`git -C <root>/<ws>/<repo> log origin/<default>..HEAD`, `git -C <root>/<ws>/<repo> stash list`, or the stray file
names). With `--dry-run`, stop here.

## 4. Confirm and remove

Ask once with `AskUserQuestion`, naming every `remove` workspace in the question. Offer: remove them all, pick
which ones, or remove none. Ask a separate question for the `ask` rows, because only the user knows whether a
workspace that was never started is still wanted. The default for those is to keep them.

Then remove what the user confirmed, in one Bash call:

```sh
overbridge rm ENG-36603; overbridge rm ENG-37729
```

`overbridge rm` handles an orphan the same way as a workspace: it removes the folder's registered worktrees,
prunes them, and deletes the folder. It refuses when a worktree holds uncommitted changes or unpushed commits,
or the folder holds files that are not worktrees. When it refuses, report what it printed and move that
workspace to "review first". Never pass `--force`.

For a `rebind` row, don't remove anything. Tell the user the PR belongs in a workspace named for its own item,
and offer the move:

```sh
overbridge release <repo> --ws <ws>
overbridge start <repo> <the PR's item> --prompt "/pickup #<pr>"
```

Run it only when the user agrees and the row has no blockers. The old workspace then shows up as `item-done` on
the next scan.

## 5. Finish

Run `overbridge cleanup` again (the table form) and report: what was removed, what `overbridge rm` refused and
why, and what is still waiting on the user.

## Rules

- Never remove a workspace whose `blockers` is not empty, and never use `overbridge rm --force`.
- Never remove without the user's answer in this run. An earlier yes does not carry over.
- Never use `rm`, `git worktree remove`, or `git worktree prune`. `overbridge rm` does the work of all three and checks for unsaved work first.
- A workspace with `problems` stays. Say which read failed, so the user can retry.
- Orchestration tabs (`@root`) and workspaces already being removed are not in the scan.
