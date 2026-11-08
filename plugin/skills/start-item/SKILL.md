---
name: start-item
description: Start work on a work item (GitHub issue or Jira ticket). Reads the item, runs the scope check, claims a branch named for it in this workspace, then enters plan mode to design the change. Use when the user says "start 123", "pick up ENG-123", "work on issue 123", "begin this item", or passes an item id and wants to start.
---

# Start an item

```
orient → read the item → scope-item → [scope gate] → claim branch → plan mode
```

Scope comes before the branch: if the item splits, the branch belongs to the first slice.

## Arguments

An item id (`123`, `#123`, `ENG-123`). Ask for it if missing.

## 1. Orient

```sh
overbridge whoami                  # must name a workspace; if not, stop and say so
overbridge status                  # which repos this workspace holds, and their claims
overbridge config check            # the repo's overbridge.yml must validate
overbridge config get project-management.name
```

If the item belongs to a repo this workspace does not hold yet, `overbridge checkout <repo> <branch>`
adds it in step 4. If `project-management` is unset, stop: tell the user to add it to `overbridge.yml`.

## 2. Read the item

```sh
overbridge item view <id>
```

Then the body, acceptance criteria, comments and linked items, from the provider's CLI
(`gh issue view <id> --comments` for github, `jira issue view <id> --comments 20` for jira).
Extract: the goal, the acceptance criteria by letter (`A`, `B`), linked or blocking items, and any
clarification in the comments. Unlettered criteria on an older item: letter them in order for the
plan, and offer to write the letters back with `overbridge item edit`.

Look for an open PR that already covers it: `gh pr list --search "<id>" --state open`. If one exists,
stop and offer `pickup` instead of starting again.

## 3. Scope gate (STOP on SPLIT or CLARIFY)

Run the `scope-item` skill on the id. `SPLIT` and `CLARIFY` are hard stops: surface them and wait.
On `SPLIT`, continue with the first slice's id only.

## 4. Claim the branch, in a workspace of its own

Each item gets its own workspace, named for it (`ENG-123`, `gh-app-12`). Look at `overbridge status`:

- **This workspace is already on this item** (a claimed branch whose `overbridge item from-branch` is `<id>`):
  `overbridge start` opened it for you. Go to step 5.
- **This workspace holds no claims** (a fresh `scratch` or by-hand workspace): claim in place.
- **It holds a claim for a different item**: hand off. Run

  ```sh
  overbridge start <repo> <id>
  ```

  It creates the item's workspace, claims the item's branch there and opens a new tab whose Claude
  runs `/start-item <id>`. If the item already has a workspace it focuses that tab instead. Tell the
  user which workspace and tab it opened, then **stop**: the plan happens in the new tab, not here.
  If `overbridge start` refuses (the branch or issue is claimed elsewhere), stop and say which workspace holds it.

Claiming in place:

```sh
BRANCH=$(overbridge item branch <id>)
overbridge checkout <repo> "$BRANCH"
```

`overbridge checkout` claims the branch for this workspace and refuses if another workspace holds it.
If it refuses, stop and tell the user which one does. Never use `git switch` or `git checkout`.

If the branch already exists with commits, say so and ask whether to continue on it.

## 5. Plan mode

Enter plan mode. The plan has these sections:

- **Goal**: one sentence.
- **Acceptance criteria**: the lettered list, copied from the item.
- **Approach**: ordered steps, riskiest first. Name the files and modules touched.
- **Test approach**: for each criterion, the test that proves it and at what level (unit, integration,
  end to end), or why it is not worth a test. Use the repo's own commands from
  `overbridge config get commands.test` and `commands.typecheck` (unset means the repo has none).
- **Open questions**: anything you could not settle from the item.

Do not start implementing. The plan ends at the user's approval.
