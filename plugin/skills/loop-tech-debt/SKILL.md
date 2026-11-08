---
name: loop-tech-debt
description: Turn a described tech-debt problem into a tracked, shipped fix. File a tech-debt work item (GitHub issue or Jira ticket, under the repo's tech-debt container), then drive it end to end with loop-item. Use when the user describes a code or quality problem they want fixed and tracked ("there's tech debt in X, fix it and track it", "file a tech-debt item for this and do it", "loop tech debt", "clean this up under an item").
---

# Loop tech debt

Take a free-text problem statement, file it as a tech-debt item, then run the full lifecycle:

```
file tech-debt item (under the tech-debt container)  →  loop-item
```

This skill frames and files the item. It does not reimplement start, plan or PR logic: `loop-item` does that.

## Guard: only inside a workspace

```sh
echo $OVERBRIDGE_NAME
overbridge config check
overbridge config get project-management.name
```

If `OVERBRIDGE_NAME` is empty, **stop**: this must run from a Claude session inside an overbridge workspace. Do not file an item or `cd` anywhere. Name the current directory and say so.

If `project-management` is unset or `config check` fails, stop and say what is missing. `overbridge item create` needs a provider.

## Arguments

The **problem description**, as free text. Ask what the tech-debt problem is if none is given.

## Phase 1: Scope the problem

Investigate briefly so the item is concrete and the fix well framed:

- Locate the affected code. Use the Explore agent with `model: "sonnet"` for broad searches. No branch is claimed yet, so read the default branch rather than whatever the workspace has checked out: `git fetch origin`, then `git grep <pattern> origin/<default>` and `git show origin/<default>:<path>`. Hand those commands to the Explore agent too.
- Summarise **what** the debt is, **why** it is a problem, and a rough **fix approach**.
- Draft the item body with lettered acceptance criteria (`**A.**`, `**B.**`) and numbered sub-criteria where one criterion has several rules. Every criterion must be something a test, a command or a look at the running app can confirm.
- Size it from what you found. If the investigation could not bound the work, the item needs `scope-item` before it is filed.

Keep it tight: this is framing, not the implementation. The detailed plan happens inside `loop-item`.

**Confirm the summary and acceptance criteria with the user before filing.**

If this workspace already holds a branch with local work or an open PR for this repo, say so before filing. `overbridge checkout` will move this workspace, and the item would be left filed with nowhere to work. Resolve that with the user first (finish or release the branch with `overbridge release <repo>`, or use another workspace).

## Phase 2: File the item

Run the humanizer pass over the body first, if the `humanizer` skill is installed.

```sh
overbridge item create --tech-debt --title "<title>" --body-file - <<'EOF'
<the filled body>
EOF
```

`--tech-debt` files it under the container named by `project-management.tech-debt` in `overbridge.yml`: a parent item id, or `label:<name>` to tag it instead. With that key unset the item is filed with no parent: tell the user, and offer to set the key. Never file a stray tech-debt item by hand with `gh issue create`.

Add `--label` only where the repo's convention asks for it.

The command prints `{id,title,url}`. Report the id, title and URL as a link. Read the item back (`gh issue view <id>` or `jira issue view <id>`, per `project-management.name`) and confirm the body landed as sent. A write can silently drop a section.

## Phase 3: Run the item

Invoke **`loop-item`** with the new id.

That handles: start-item (scope gate included) → plan-approval gate → implement → self-review → ship-pr → green build. The plan-approval pause still applies: implementation does not start until the user approves the plan.

## Rules

- Always file through `overbridge item create --tech-debt`. Never create a stray tech-debt item.
- The Phase 1 investigation is a measurement, not a guess.
- Delegate the lifecycle to `loop-item`.
- Confirm the framing with the user before filing, and respect `loop-item`'s plan gate before coding.
- Commit messages and code comments are exempt from the humanizer pass.
