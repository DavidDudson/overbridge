---
name: workspace-admin
description: Set up and manage ws workspaces from outside a workspace — register repos, create/remove workspaces, add repos to a workspace, launch the zellij grid. Use when the user says "add repo X to ws", "new workspace", "spin up a workspace for …", "remove ws3", "launch workspaces", or asks how the ws tool works. Not for workspace-bound sessions (the guard blocks admin commands there).
---

# Managing ws workspaces

Layout under `$WS_ROOT` (default `~/workspaces`):

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
ws init                                   # once
ws repo add <name> <git-url> [--branch main]
ws repo ls
ws sync                                   # fetch all bare repos

ws new [name] -r <repo> [-r <repo>...]    # default name ws1, ws2, …
ws add <repo> --ws <name>                 # add another repo to an existing workspace
ws rm <name> [--force]                    # refuses with uncommitted changes unless --force
ws status --all

ws up [--fresh]                           # zellij session "workspaces": 4 workspaces per tab,
                                          # Claude pane above shell pane per workspace
ws claude <name>                          # run one bound Claude outside zellij
```

## Notes

- `ws up` attaches if the session exists; new workspaces only show after `ws up --fresh`
  (that kills the session, so confirm with the user first).
- `ws rm --force` discards uncommitted work. Confirm with the user before using it.
- Repo names: letters, digits, `-`, `_`. URL is anything `git clone` accepts.
- One branch/PR per repo can be claimed by exactly one workspace. To move work,
  `ws release <repo> --ws <from>` then `ws checkout <repo> <branch> --ws <to>`.
