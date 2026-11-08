---
name: workspace-admin
description: Set up and manage overbridge workspaces from outside a workspace — register repos, create/remove workspaces, add repos to a workspace, launch the zellij grid. Use when the user says "add repo X to overbridge", "new workspace", "spin up a workspace for …", "remove ws3", "launch workspaces", or asks how the overbridge tool works. Not for workspace-bound sessions (the guard blocks admin commands there).
---

# Managing overbridge workspaces

Layout under `$OVERBRIDGE_ROOT` (default `~/workspaces`):

```
repos.toml          # registry: [repos.<name>] url = "...", default_branch = "..." (optional)
.bare/<repo>.git    # bare clones, fetched not re-cloned
.ws/state.json      # claims (ws → repo → branch/pr); edit only via ws commands
.ws/layout.kdl      # generated zellij layout
<ws>/<repo>/        # git worktree per repo per workspace
<ws>/.claude/       # generated settings binding Claude to the workspace (guard hook)
<ws>/CLAUDE.md      # generated workspace instructions
```

## Commands

```sh
overbridge init                                   # once
overbridge repo add <name> <git-url> [--branch main]
overbridge repo ls
overbridge sync                                   # fetch all bare repos

overbridge new [name] -r <repo> [-r <repo>...]    # default name ws1, ws2, …
overbridge add <repo> --ws <name>                 # add another repo to an existing workspace
overbridge rm <name> [--force]                    # refuses with uncommitted changes unless --force
overbridge status --all

overbridge spinup [-n 6]                          # create empty workspaces up to N (default 4),
                                          # then rebuild the zellij session (kills running panes)
overbridge up [--fresh]                           # zellij session "workspaces": one tab per workspace with a
                                          # sidebar, a top panel, and the agent above a shell
overbridge layout                                 # print the layout `up` would use (stderr says where from)
overbridge claude <name>                          # run one bound Claude outside zellij
```

## Notes

- `overbridge up` attaches if the session exists; new workspaces only show after `overbridge up --fresh`
  (that kills the session, so confirm with the user first).
- `overbridge rm --force` discards uncommitted work. Confirm with the user before using it.
- Repo names: letters, digits, `-`, `_`. URL is anything `git clone` accepts.
- One branch/PR per repo can be claimed by exactly one workspace. To move work,
  `overbridge release <repo> --ws <from>` then `overbridge checkout <repo> <branch> --ws <to>`.
