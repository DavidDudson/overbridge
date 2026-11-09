---
name: scope-item
description: Check that a work item (GitHub issue or Jira ticket) is one clear goal before any branch is cut, and say PROCEED, SPLIT or CLARIFY. Use before starting work on an item, when the user says "scope this", "is this too big", "should we split this", or when start-item calls it.
---

# Scope an item

Decide whether one branch and one PR can finish this item. Read-only: nothing is created, edited or
transitioned here.

## Extensions

Extension files can add to this skill without changing it. At each step marked `ext: <phase>`, run
`overbridge ext scope-item <phase>` before you do the step, and follow what it prints as well as this skill. Where
the two conflict, the extension wins. It prints nothing when there is no extension. Its phases: `verdict`.

## Arguments

An item id (`123`, `#123`, `ENG-123`). Ask for it if missing.

## Read the item

```sh
overbridge item view <id>          # {id,title,url}
```

The body, acceptance criteria and comments come from the provider's own CLI, because `item view`
does not carry them yet. Pick by `overbridge config get project-management.name`:

- `github`: `gh issue view <id> --comments`
- `jira`: `jira issue view <id> --comments 20`

Read linked or parent items too, when the body names them.

## Judge

Check each of these against the body, and quote the line that decides it:

- **One goal.** Can the title be written without "and"? Two independent outcomes mean two items.
- **Checkable done.** Every acceptance criterion is something a test, a command or a look at the
  running app can confirm. "Improve", "clean up" and "make better" with no measure are not.
- **One reviewable PR.** Rough size: how many areas of the codebase change, and does anything need to
  land before the rest (a migration, an API, a rename)?
- **No hidden decision.** A choice the item leaves open (which library, which behaviour) that the
  author, not you, must make.

## Verdict

`ext: verdict`: run `overbridge ext scope-item verdict` first (what to record with the verdict, such as an estimate).

Print exactly one of:

- `PROCEED`: one goal, checkable, reviewable as one PR. One line of why.
- `SPLIT`: list the slices, each with its own goal, its acceptance criteria and its order (what must
  land first). The first slice is the one to run now.
- `CLARIFY`: list the questions, each naming the line of the item that is unclear. Do not guess
  answers.

`SPLIT` and `CLARIFY` are stops. Put them to the user and wait. Never carry on unsplit on their
behalf.

To file the slices after the user agrees, one per slice:

```sh
overbridge item create --title "<slice title>" --body-file - --parent <id> <<'EOF'
<slice body with its acceptance criteria>
EOF
```

Add `--label` as the repo's convention asks. Run the humanizer pass over every body before filing it.
