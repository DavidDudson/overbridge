---
name: workspace-admin
description: Set up and manage overbridge workspaces from outside a workspace — register repos, create/remove workspaces, add repos to a workspace, launch the zellij session. Use when the user says "add repo X to overbridge", "new workspace", "spin up a workspace for …", "remove ws3", "launch workspaces", or asks how the overbridge tool works. Not for workspace-bound sessions (the guard blocks admin commands there).
---

# Managing overbridge workspaces

Layout under `$OVERBRIDGE_ROOT` (default `~/workspaces`):

```
repos.toml          # registry: [repos.<name>] url = "...", default_branch = "..." (optional)
.bare/<repo>.git    # bare clones, fetched not re-cloned
.overbridge/state.json   # claims (ws → repo → branch/pr); edit only via overbridge commands
.overbridge/layout.kdl   # generated zellij layout (a layouts/overbridge.kdl in the zellij config dir replaces it)
.overbridge/agent/       # per-workspace agent state written by the hook, read by the sidebar
<ws>/<repo>/        # git worktree per repo per workspace
<ws>/<repo>/overbridge.yml  # per-repo config: work items, apps, check commands, review, ide
<ws>/.claude/       # generated settings binding Claude to the workspace (guard + agent state hooks)
<ws>/CLAUDE.md      # generated workspace instructions
```

## Commands

```sh
overbridge init                                   # once
overbridge repo add <name> <git-url> [--branch main]
overbridge repo ls
overbridge sync                                   # fetch all bare repos

overbridge start <repo> <id>                      # workspace named for the item (ENG-123, gh-app-12), on its
                                          # branch, in a new tab running /start-item; focuses an existing one
overbridge new <name> -r <repo> [-r <repo>...]    # by hand; name it for its work item
overbridge add <repo> --ws <name>                 # add another repo to an existing workspace
overbridge rm <name> [--force]                    # refuses with uncommitted changes unless --force
overbridge status --all

overbridge spinup                                 # rebuild the zellij session over existing workspaces
                                          # (creates an empty 'scratch' one if there are none; kills running panes)
overbridge up [--fresh]                           # zellij session "workspaces": one tab per workspace with a
                                          # sidebar, a top panel, and the agent above a shell
overbridge layout                                 # print the layout `up` would use (stderr says where from)
overbridge claude <name>                          # run one bound Claude outside zellij
```

## Config

Per-repo rules go in the repo's `overbridge.yml` (see the README for every key and
`overbridge.example.yml` for a commented copy); validate with `overbridge config check`. Global
settings live in `repos.toml`: `[sidebar] width = 28` sets the tab sidebar width (12 to 80).

## Notes

- `overbridge up` attaches if the session exists; new workspaces only show after `overbridge up --fresh`
  (that kills the session, so confirm with the user first).
- `overbridge rm --force` discards uncommitted work. Confirm with the user before using it.
- Repo names: letters, digits, `-`, `_`. URL is anything `git clone` accepts.
- One branch/PR per repo can be claimed by exactly one workspace. To move work,
  `overbridge release <repo> --ws <from>` then `overbridge checkout <repo> <branch> --ws <to>`.
