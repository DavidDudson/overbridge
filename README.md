# overbridge

Multi-repo workspaces for parallel Claude Code sessions, laid out in zellij.

- **Bare clones, not re-clones.** Each registered repo is cloned once into
  `~/workspaces/.bare/<repo>.git`; every workspace gets a `git worktree` of it.
- **One workspace per work item.** Named for the item (`ENG-123` for Jira, `gh-app-12` for GitHub issue 12 of
  `app`), created by `overbridge start`, wiped when its PR is open and nothing is left locally.
- **Workspaces hold several repos.** `~/workspaces/ENG-123/{app,infra}` etc.
- **Claims.** Each workspace tracks the branch/PR it is on per repo. A branch or PR
  claimed by one workspace cannot be checked out by another. A `<type>/<n>-<slug>` branch
  also claims issue `<n>`, so `feat/383-a` and `fix/383-b` cannot be worked in two workspaces.
- **Stacked PRs.** With [gh-stack](https://github.github.com/gh-stack/), a claim covers
  the whole stack (read live from the catalog gh-stack keeps in the bare repo).
  `overbridge checkout <repo> #<pr>` on a stacked PR runs `gh stack checkout`; `gh stack up/down/add`
  move within the claim, and `overbridge pr` moves the claim to the current layer.
- **Bound Claude.** Every workspace gets a generated `.claude/settings.json` with a
  `overbridge guard` PreToolUse hook: no file access in other workspaces, no writes outside
  its own, no raw `git switch`/`checkout <branch>`/`gh pr checkout`/`gh stack checkout`/
  `gh stack trunk`/`git worktree`,
  no workspace admin commands.
- **Trusted folders.** overbridge marks each workspace folder it creates as trusted in Claude's `~/.claude.json`
  (`$CLAUDE_CONFIG_DIR/.claude.json` when set), so a session started there skips the "trust this folder" prompt.
  `overbridge rm` removes the entry again. Folders made by hand under the overbridge root still prompt.
- **Zellij tabs.** `overbridge up` opens a session whose first tab is the orchestration tab. It runs
  Claude in the overbridge root without the workspace guard, for work that spans workspaces, such as
  filing issues or starting workspaces. After it comes one tab per workspace: a sidebar down the left,
  the top panel across the top, and then the agent. Terminal and diff panes open to the agent's right
  when you press their top panel buttons. Each agent resumes with `--continue` when Claude has a
  transcript for its folder. A file at
  `<zellij config dir>/layouts/overbridge.kdl` replaces the generated layout;
  `overbridge layout` prints what would be used and where it came from.

## Quick start

```nu
overbridge init
overbridge repo add app git@github.com:you/app.git
overbridge repo add infra git@github.com:you/infra.git
overbridge spinup                       # fresh zellij session over the existing workspaces ('scratch' if none)
overbridge start app 12                 # workspace gh-app-12 on the issue's branch, in a new tab running /start-item
overbridge start app ENG-123            # a Jira item: workspace ENG-123
overbridge start app --task file-x --prompt 'file a ticket for X'   # no item yet: workspace file-x on branch task/file-x
```

`overbridge spinup` always rebuilds the session, killing running panes. Use `overbridge up` to just
attach. `overbridge start` adds a tab to the running session in the background, so you stay on your tab; an
item that already has a workspace is focused instead of started again. Workspaces can also be made by hand: `overbridge new <name> -r app -r infra`.

**Cleanup.** A workspace with at least one open PR, where every other claimed branch has a merged PR, with no
uncommitted changes and no unpushed commits, shows a **Cleanup** button in its top panel. Press it twice within
five seconds. If a repo has uncommitted changes or unpushed commits by then, Cleanup refuses and nothing changes.
Otherwise the tab closes at once, the workspace leaves every sidebar, and you land on the next tab that needs
attention, or else the tab next to it. A background process then re-checks the PRs, stops the workspace's apps, and
runs `overbridge rm`. If any of that fails, the workspace comes back with the error on its sidebar card, and its tab
reopens. A merged claim does not block it; a closed (unmerged) PR or a branch with no PR does.

**Ending a session.** When you exit a workspace's Claude on purpose (`/exit` or Ctrl-D), overbridge removes the
workspace the way Cleanup does. Its tab closes, it leaves every sidebar, and a background process finishes the removal.
It doesn't need an open PR. If a repo has uncommitted changes or unpushed commits, the workspace stays in the list,
marked `ended · unsaved work`, and goes once that work is pushed or thrown away. `/clear` and `/resume` don't count as
ending a session. Nor does a session that ends because zellij quit or the machine restarted, so those workspaces resume
on the next `overbridge up`. If you're on another tab when it goes, you stay there.

**Removal once every PR merges.** When every claimed branch has a merged PR, overbridge removes the workspace through
the same background flow, without a key press. Any open sidebar can run the check (`overbridge top sweep`), and only
one of them runs it each minute, so it works whether or not the workspace's tab is open. The workspace stays if a repo
has uncommitted changes or its HEAD is not the merged PR's head commit, and its sidebar card reads "merged · unsaved
work". The check compares HEAD with the PR's head rather than the default branch, because a squash merge leaves the
branch's commits off the default branch. A workspace also stays while its agent is working, and goes once the agent is
idle or has ended. A claim with no PR, or a PR closed without merging, keeps the workspace. Orchestration tabs are never
removed this way.

**Seeing what was removed.** Every removal shows at the bottom of the sidebar, so none happens unseen. A yellow
`🧹 4s removing <title>` row shows one in progress. A finished one stays for an hour and names what removed it:
`🧹 3m merged <title>` for the merged-PR check, `exited` for an ended session, and `cleaned` for the Cleanup button.
A failed removal shows as a red `✗ 1m failed <title>`. The sidebar shows at most three of these rows, newest first,
and `state.json` keeps the last 20 under `cleanups`.

Inside a workspace (shell pane or its Claude):

```nu
overbridge checkout app feat/login        # adds repo if missing, claims + switches
overbridge checkout infra '#42'           # pick up a PR
overbridge pr                              # record PRs for claimed branches
overbridge status --all
overbridge release app
overbridge shell app -- just test         # run a command in the repo's dev shell
overbridge check app -- just test         # the same, queued: one heavy command at a time across workspaces
```

Run `overbridge help` for every command.

## Layout

```
~/workspaces/               ($OVERBRIDGE_ROOT)
  repos.toml                registry: [repos.<name>] url, default_branch?
  .bare/<repo>.git          bare clones (refspec → refs/remotes/origin/*)
  .overbridge/state.json    claims, lock-protected (.overbridge/state.lock)
  .overbridge/layout.kdl    generated zellij layout (plus agent/, top/, apps state)
  .overbridge/check-queue/  one ticket per queued or running `overbridge check`
  <ws>/                     named for its work item, e.g. gh-app-12
    CLAUDE.md               generated workspace rules
    .claude/settings.json   OVERBRIDGE_NAME env + guard hook
    <repo>/                 worktree
```

## Claude Code plugin

`plugin/` ships skills: `workspace`, `ship-pr` (commit, PR, stacked PRs and splitting a branch into a stack,
green build, Copilot and CodeRabbit feedback), `workspace-admin`, and the dev loop (`loop-item`, `start-item`,
`scope-item`, `pickup`, `resolve-feedback`, `merge-main`, `rebase-main`), the dependency skills (`update-library`, `audit-vulns`, `loop-tech-debt`) and `read-handoff` (continue from a handoff file after `/clear`). They read the
repo's `overbridge.yml` (`project-management`, `commands`) and work with work items through `overbridge item`.
`loop-tech-debt` files items with `overbridge item create --tech-debt`, so set `project-management.tech-debt`.
`audit-vulns` reads Dependabot alerts, so it needs a GitHub repo.

You don't install it. Every workspace and orchestration Claude starts with both plugins enabled from the
installed overbridge (`extraKnownMarketplaces` and `enabledPlugins`, written to `.claude/settings.json` and passed
with `--settings`), so the skills always match the running version. `overbridge start` stops with a fix when the
install has no plugins, and warns when Claude has another `overbridge` marketplace registered, such as one added
by hand. Remove that one with `claude plugin marketplace remove overbridge`.

`plugin-review/` is a second plugin, `overbridge-review`, with the review panel: `mob-review`, `review-pr`,
`update-personas` and the `persona-*` reviewers (security, code-quality, naming, comments, error-handling,
architecture, test-design, integration-test, performance, resilience, pr-size, api-design, database,
github-actions, shell, typing, a11y, async-state, ac-check, production-protector, skills). It reads `review.*`
from `overbridge.yml` (see below). It is enabled in the same way as the first.

`mob-review` uses only the built-in `code-review` skill. `review-pr` claims the PR with `overbridge checkout`.
`loop-item` calls `mob-review` when this plugin is installed. Nothing in it needs `pickup`; `merge-main` and
`resolve-feedback` from `overbridge` are optional extras.

Repo-local personas go in `review.local-dir` (default `.overbridge/personas`) as `<name>/SKILL.md` or `<name>.md`,
in the same format as a built-in. A local persona with a built-in's name replaces it.

### Skill extensions

A team can add to the skills without forking them. Each skill names its extension points, called phases. At each
one it runs `overbridge ext <skill> <phase>` and follows what that prints as well as its own steps. Where the two
conflict, the extension wins.

An extension is a Markdown file of instructions, at `<dir>/<skill>/<phase>.md`. A file at `<dir>/all/<phase>.md`
applies to every skill with that phase, such as `prose`. overbridge reads these directories, least specific first:

1. Each directory in `skill-extensions` in the root `config.yml`, in order. A path can be absolute, start with
   `~/`, or be relative to the root.
2. The repo's own `.overbridge/ext/`.

```yaml
# <root>/config.yml
skill-extensions:
  - ~/team-skills/overbridge-ext
```

| skill | phases |
| --- | --- |
| `ship-pr` | `commit`, `screenshots`, `pr-body`, `post-pr`, `prose` |
| `start-item` | `read-item`, `plan` |
| `scope-item` | `verdict` |
| `resolve-feedback` | `fix`, `prose` |
| `loop-tech-debt` | `create-item` |
| `update-library` | `create-item`, `prose` |
| `audit-vulns` | `create-item`, `prose` |
| `mob-review` | `panel` |

`overbridge ext list` shows every extension file it finds. A skill that runs `overbridge ext` for a phase with no
file gets no output and carries on as written.

## Install

overbridge runs on [Bun](https://bun.sh) 1.3 or later and needs `git`, `gh`, and `zellij` on PATH.

### npm, from GitHub Packages

Releases are published as `@daviddudson/overbridge`. GitHub Packages needs a token with `read:packages`, even for a
public package. `gh auth refresh -s read:packages` adds that scope to the `gh` token. The single quotes below keep
the token out of `~/.npmrc`: npm reads `GITHUB_TOKEN` from the environment at install time.

```sh
export GITHUB_TOKEN="$(gh auth token)"
npm config set '//npm.pkg.github.com/:_authToken' '${GITHUB_TOKEN}'
npm install -g @daviddudson/overbridge --@daviddudson:registry=https://npm.pkg.github.com
```

Set `OVERBRIDGE_SELF=overbridge` in your shell profile. Generated hooks and layouts then call `overbridge` on PATH,
not the installed script's path, which changes on upgrade.

### Nix

`packages.<system>.default` wraps `bun src/cli.ts` and sets `OVERBRIDGE_SELF=overbridge` for you. `ws` is kept as an
alias.

### Releases

Each merge to `main` can release. [semantic-release](https://semantic-release.gitbook.io) reads the conventional
commits since the last `v*` tag: `fix:` and `perf:` release a patch, `feat:` a minor, and a `!` after the type a
major. PRs are squash-merged, so the PR title is the commit it reads.

## Platforms

Linux (x86_64, aarch64) and macOS (Apple silicon; the flake builds `aarch64-darwin`). Process lookups use `/proc`
where it exists and `ps` elsewhere (`src/proc.ts`); the browser opener is `open` on macOS and `xdg-open` elsewhere.
CI runs the checks on both. On macOS the default filesystem ignores case, which the guard's path checks do not:
treat it as a guardrail there too, not a sandbox.

## Environment

| var          | default        | purpose                                    |
| ------------ | -------------- | ------------------------------------------ |
| `OVERBRIDGE_ROOT`    | `~/workspaces` | workspaces root                            |
| `OVERBRIDGE_NAME`    | –              | binds the process to a workspace (Claude)  |
| `OVERBRIDGE_SESSION` | `workspaces`   | zellij session name                        |
| `OVERBRIDGE_SELF`    | script path    | how generated hooks/layouts invoke `overbridge` |

## Limits

The guard is a guardrail, not a sandbox: Bash is checked by pattern (paths into
other workspaces, branch-changing git commands), so an obfuscated command can get
past it. gh aliases (`gh co`) and custom `gh stack alias` names are not recognised.

## Upgrading from `ws`

- The binary is `overbridge`; `ws` stays as an alias.
- `WS_ROOT`, `WS_NAME`, `WS_SELF` and `WS_SESSION` still work but warn. Use the `OVERBRIDGE_*` names.
- `<root>/.ws/` is renamed to `<root>/.overbridge/` automatically on first use.
- The `gh repo list` cache moved to `~/.cache/overbridge/github-repos.json`; refresh it with the command in a workspace's `CLAUDE.md`.

## overbridge.yml

Per-repo rules live in `overbridge.yml` at the repo root. A missing file means defaults, and the
[root `config.yml`](#root-configyml) can add to or override it without a commit to the repo.
Editors can use [`overbridge.schema.json`](overbridge.schema.json) for completion.

```yaml
version: 1
project-management:
  name: github        # github | jira
  project: owner/repo # GitHub: owner/repo or project number; Jira: project key
  # url: https://example.atlassian.net   # optional provider base URL
  # tech-debt: 42                        # optional: parent item for tech-debt items, or label:tech-debt
apps: []              # launch/teardown commands, see below
commands:             # all optional; skills run these to check a change
  lint: pnpm lint
  typecheck: pnpm typecheck
  test: pnpm test
  build: pnpm build
  format: pnpm format
shell: nix develop --command   # dev shell prefix, see below; or { enter, env, key }
review:
  personas: [security, code-quality]   # optional; default is auto-select by diff signals
  exclude: [pr-size]                   # skipped after selection
  local-dir: .overbridge/personas      # repo-local personas (this is the default)
ide: vscode           # vscode | zed | webstorm
```

`overbridge config check [path]` validates a repo's file together with the root `config.yml`, or the root
`config.yml` alone when that is the path. Unknown keys get a suggestion.
`overbridge config show [path]` prints the resolved config as JSON, and says on stderr which files went into it.
`overbridge config get <key> [path]` prints one resolved value (`commands.test`, `review.local-dir`) and exits
non-zero when it is unset.

### Dev shells

A repo's `shell` key says how to enter its dev shell. `overbridge shell <repo> [--ws name] -- <cmd>` runs `cmd`
in it from anywhere in the workspace (in the current directory when that is inside the repo, else its root), and
exits with the command's code. A repo with no `shell` runs the command as it is, so the wrapper is always safe.
If the shell's program is not on PATH (`nix` on a machine without Nix, say), the command runs as it is, with a
warning, so the repo's tools need to be on PATH another way.

- **Prefix only** (`shell: nix develop --command`): each call runs `<prefix> <cmd>` from the repo, then moves to the wanted directory.
- **With `env` and `key`**: overbridge runs `env` once, keeps the variables that differ from its own, and stores them under
  `$XDG_CACHE_HOME/overbridge/shell/`, keyed on the worktree, the config and the contents of the `key` files. Later calls run
  the command directly with that env, so they skip the shell's start-up until a key file changes.

Where it applies:

- **One repo in the workspace**: the agent starts inside the shell, with the workspace root as its directory.
- **Several repos**: the agent starts plain, and the generated workspace `CLAUDE.md` tells it to use
  `overbridge shell` and `overbridge check`. The skills run `commands.format` and installs through `overbridge shell`,
  and lint, typecheck, test, and build through `overbridge check`. The top panel's terminal button opens your `$SHELL`
  in the first repo's shell.
- Adding a second repo to a workspace whose agent is already inside the first repo's shell prints a warning: the first
  env leaks into the agent. The add goes ahead, and `overbridge shell` still gives the second repo its own.

### Check queue

`overbridge check [repo] [--ws name] [--timeout-seconds n] -- <cmd>` runs a heavy command, such as lint, typecheck,
test or build, so that only one runs at a time across every workspace. The skills send the repo's `commands.lint`,
`typecheck`, `test`, and `build` through it. The repo defaults to the one the current directory is in, then to the
workspace's only repo.

1. **Queue.** Each call writes a ticket to `.overbridge/check-queue/`. The oldest ticket whose process is still alive
   holds the turn, and the others wait in order. Waiters remove tickets whose process has died. If a dead holder left
   its command running, they kill that command too.
2. **Load.** Once it holds the turn, the run waits until the 1-minute load average is under `max-load-percent` of the cores.
3. **Run.** The command runs in the repo's dev shell, as with `overbridge shell`, in a process group of its own. A
   command started inside a held run, such as a git hook, runs straight away instead of queueing behind its parent.
4. **Stop.** The command is killed (TERM, then KILL after 10 seconds) when it runs past `timeout-seconds` (exit 124),
   or when its process group uses no CPU for `stall-seconds` (exit 137). If no turn comes within `wait-seconds`, the
   call gives up with exit 75. Otherwise it exits with the command's own code.

`--timeout-seconds` raises or lowers the time limit for one run. The tab sidebar shows the running command, how long
it has run, and who is waiting.

### Keys and defaults

| key | default | meaning |
| --- | --- | --- |
| `version` | `1` | schema version; only `1` exists |
| `project-management.name` | none | `github` or `jira`. Without the block, item features are off |
| `project-management.project` | none | GitHub: `owner/repo` or a Projects v2 number (issues then come from the repo checked out in the workspace). Jira: the project key |
| `project-management.url` | none | Jira site, e.g. `https://example.atlassian.net`; needed for ticket links |
| `project-management.tech-debt` | none | where tech-debt items go: an item id (parent) or `label:<name>`; unset files them with no parent |
| `project-management.branch` | GitHub `{number}-{slug}`, Jira `feat/{id}-{slug}` | branch name template. Placeholders: `{id}` (`ENG-12`, `12`), `{number}` (`12`), `{slug}` (the title, at most 40 characters), and `{type}` (see `branch-types`). It must use `{id}` or `{number}`. For GitHub, the number must start the name or follow `/` or `#`, and be followed by `-` or the end |
| `project-management.workspace` | GitHub `gh-{repo}-{number}`, Jira `{id}` | workspace name template. Placeholders: `{id}`, `{number}`, and `{repo}`. It must use `{id}` or `{number}` |
| `project-management.branch-types` | none | the `{type}` for each item type: a Jira issue type, or a GitHub label. The first of the item's types with an entry wins, ignoring case, then `default`, then `feat`. Looking up the type needs the network, so it happens only when `branch` uses `{type}` |
| `project-management.issue-type` | `Task` | Jira issue type for new items |
| `apps` | `[]` | launchable apps, see [Apps](#apps) |
| `commands.lint`, `typecheck`, `test`, `build`, `format` | none | shell commands the skills run to check a change; a missing one means the repo has none |
| `check-queue.max-load-percent` | `70` | start a queued run only while the 1-minute load average is under this share of the cores; over 100 allows more load than cores. See [Check queue](#check-queue) |
| `check-queue.timeout-seconds` | `180` | kill a queued run after this long; `--timeout-seconds` overrides it for one run |
| `check-queue.stall-seconds` | `300` | kill a queued run once its processes have used no CPU for this long |
| `check-queue.wait-seconds` | `900` | give up (exit 75) when a run gets no turn, or the load stays high, for this long |
| `shell` | none | the repo's dev shell: a command prefix (`nix develop --command`, `direnv exec .`), or a mapping `enter` (the prefix), `env` (a command printing the env NUL-separated, as `env -0` does) and `key` (repo-relative files whose contents invalidate the cached env; needs `env`). See [Dev shells](#dev-shells) |
| `review.personas` | auto | reviewer personas to run; unset selects by diff signals |
| `review.exclude` | `[]` | personas to skip, applied after selection |
| `review.local-dir` | `.overbridge/personas` | repo-local personas, relative to the repo root |
| `ide` | `$OVERBRIDGE_IDE`, then `$EDITOR` | `vscode`, `zed` or `webstorm`; the top panel's editor button opens the workspace folder. Unset, the button runs `$OVERBRIDGE_IDE` (an ide name or a command) or else `$EDITOR`; set those per user, not in the repo file. GUI editors only, as it is launched detached |

Providers shell out to `gh` (GitHub) and `jira` ([jira-cli](https://github.com/ankitpokhrel/jira-cli), Jira), so there
is no token to store in the config. A branch names its item when it contains the id: `123-title` or
`feat/123-title` for GitHub, `feat/ENG-12-title` for Jira (only the configured project's key counts).

### Root config.yml

`<OVERBRIDGE_ROOT>/config.yml` holds settings that live outside the repos. Use it for repos you can't or don't
want to commit an `overbridge.yml` to, and for settings that are yours rather than the repo's.
[`config.schema.json`](config.schema.json) describes it.

```yaml
version: 1
defaults:             # under every repo's overbridge.yml
  ide: zed
  project-management:
    name: jira
    project: ENG
    url: https://example.atlassian.net
repos:                # over one repo's overbridge.yml, by its name in repos.toml
  app:
    commands:
      test: pnpm test --run
  infra:
    project-management: ~   # null removes a key
```

The layers apply in this order, and a later layer wins:

1. Built-in defaults.
2. `defaults` in the root `config.yml`.
3. The repo's `overbridge.yml`.
4. `repos.<name>` in the root `config.yml`.

Mappings merge key by key. Lists, such as `apps` and `review.personas`, replace the list below them whole. A
`null` (`~`) removes the key. Each layer can be partial: a required key, such as `project-management.project`,
only has to be set once the layers are merged. `overbridge start` reads the repo's file from its default branch, so
the root `config.yml` is how to set up a repo that has no `overbridge.yml`.

`repos.<name>` applies inside a workspace, where overbridge knows which repo a directory belongs to. Outside a
workspace, only `defaults` applies.

### Hooks

`hooks` in the root `config.yml` runs shell commands at points in a worktree's life. Each hook takes one command
or a list. They can sit under `defaults` or `repos.<name>`.

```yaml
defaults:
  hooks:
    post-add: cp ~/.config/env/"$OVERBRIDGE_REPO".env .env   # copy gitignored local files in
repos:
  app:
    hooks:
      post-add: [pnpm install]
      post-pr: my-tool record-pr "$OVERBRIDGE_PR"
```

- **`post-add`**: after a repo's worktree is added to a workspace (`new`, `add`, `start`, or `checkout` of a new repo).
- **`post-checkout`**: after `overbridge checkout` claims a branch or PR and switches to it.
- **`post-pr`**: after `overbridge pr` records an open PR for a claimed branch.
- **`pre-remove`**: before `overbridge rm` removes a workspace, once for each repo in it.

Each command runs with `sh -c` in the worktree. Its stdout goes to stderr, so it can't mix with the output of
commands such as `overbridge new`. It gets `OVERBRIDGE_HOOK`, `OVERBRIDGE_NAME` (the workspace), `OVERBRIDGE_REPO`,
`OVERBRIDGE_BRANCH`, `OVERBRIDGE_PR`, `OVERBRIDGE_ROOT`, and `OVERBRIDGE_SELF`. A hook runs after the state lock is
released, so it may call overbridge itself.

The commands in a hook run in order and stop at the first failure. A failing `post-*` hook prints a warning and the
command still succeeds. A failing `pre-remove` hook stops `overbridge rm`, and `--force` removes the workspace
anyway.

Hooks are only read from the root `config.yml`. A repo's own `overbridge.yml` can't declare them, because then
checking out someone's branch would run whatever that branch says.

### Top panel buttons

`buttons` in the root `config.yml` adds buttons to the top panel, for each repo the workspace holds. They can sit
under `defaults` or `repos.<name>`.

```yaml
defaults:
  buttons:
    - id: chromatic
      label: 🎨 Chromatic
      status: my-tool chromatic-status        # optional: run on each refresh
      url: https://example.com/{repo}/{branch}
    - id: docs
      label: 📚 Docs
      run: pnpm docs:open                     # run when pressed
      side: left
```

- **`id`** and **`label`**: required. The id must be unique within the list.
- **`url`**: opened when the button is pressed. `{ws}`, `{repo}`, `{branch}`, and `{pr}` are filled in and URL-encoded.
- **`run`**: a shell command run in the worktree, detached, when the button is pressed. Set `run` or `url`, not both.
- **`status`**: a shell command run in the worktree each time the panel refreshes (every minute, or `r`). It prints
  the text shown after the label, or a JSON object `{ "text": "…", "color": "green" }`. The colours are `red`,
  `green`, `yellow`, `blue`, `purple`, `cyan`, and `grey`. A button with a `status` stays hidden until its command
  prints something, so a command that fails or prints nothing hides it.
- **`side`**: `right` (the default) with the launchers, or `left` with the links.

The commands get `OVERBRIDGE_NAME`, `OVERBRIDGE_REPO`, `OVERBRIDGE_BRANCH`, and `OVERBRIDGE_PR`. When a workspace
holds more than one repo, each button's label starts with its repo. The buttons have no keys, because the panel's
keys are taken.

Like hooks, buttons are only read from the root `config.yml`, because `status` runs without anyone pressing anything.

### Guard additions

A top-level `guard` block in the root `config.yml` adjusts the workspace guard for every workspace. A repo's
`overbridge.yml` can't have one, so a checked-out branch can never loosen the guard.

```yaml
guard:
  read-paths:              # under the root, but readable from any workspace
    - ~/workspaces/.seeds
  deny:                    # more Bash commands to block, checked after the built-in rules
    - pattern: '\bnpm\s+publish\b'
      reason: publishing is for the user, not a workspace Claude
```

- **`read-paths`**: paths, absolute or starting with `~/`, that a workspace's Claude may read even though they are
  under the root. Write tools still can't touch them. A Bash command may name them, because the guard can't tell a
  read from a write in a shell command.
- **`deny`**: a regular expression matched against each Bash command, and the reason Claude is shown when it
  matches.

If the root `config.yml` can't be read, the guard blocks every tool call until it is fixed, as it does for any
internal error.

### Extension keys

A top-level key that starts with `x-`, such as `x-acme`, passes validation in either file. overbridge keeps it as
written and never reads it, so skills and tools built on overbridge can keep their own settings next to its
settings. Read one with `overbridge config get x-acme.squad`. Extension keys merge across layers like any other
mapping.

### Examples

A GitHub-managed repo, with checks and one app:

```yaml
version: 1
project-management:
  name: github
  project: owner/repo
commands:
  test: npm test
  lint: npm run lint
apps:
  - id: web
    start: npm run dev -- --port {port}
    ports: [3000, 3001]
    ready: { http: "http://localhost:{port}" }
    open: true
ide: vscode
```

A Jira-managed repo with a tech-debt label and no apps:

```yaml
version: 1
project-management:
  name: jira
  project: ENG
  url: https://example.atlassian.net
  tech-debt: label:tech-debt
commands:
  test: make test
review:
  exclude: [pr-size]
```

[`overbridge.example.yml`](overbridge.example.yml) is a commented copy of every key.

### Apps

`apps` declares what a repo can launch and tear down. `overbridge app` runs them
from a shell or an agent; the top panel's toggles use the same code.

```yaml
apps:
  - id: web
    label: web                  # defaults to id
    dir: apps/web               # relative to the repo root, defaults to "."
    prepare: pnpm build:libs    # optional, runs to completion before start
    start: pnpm dev --port {port}
    stop: ~                     # optional; default signals the whole process group
    ports: [3000, 3001]         # pool: at most this many workspaces run it at once
    ready: { http: "http://localhost:{port}" }   # or { tcp: "{port}" } / { tcp: 5432 }
    open: true                  # open the browser once ready
    when: feature-branch        # always (default) | feature-branch
```

`{port}` is the port allocated from the pool. Apps run detached in their own
process group, so they outlive the shell that started them and stop as a whole
tree. State lives in `<workspace>/.overbridge/apps/<repo>/<id>.json` and the log
next to it as `<id>.log`. When the pool is used up, the error names the
workspaces holding the ports.

```nu
overbridge app                 # list every app in this workspace with its status
overbridge app web start       # start, wait until ready, open the browser if asked
overbridge app web stop
overbridge app web restart
overbridge app web status      # stopped | starting | running | exited
overbridge app web log         # print the log path
```

Use `--repo <name>` when two repos declare the same id and `--no-wait` to skip the ready check.

### Tab sidebar

`overbridge sidebar` is the pane down the left of every tab. It lists each workspace with
its agent state emoji (🆕 empty: just started or cleared, 💤 idle, 🔄 busy, ✅ done, ⏳ done but background tasks still running, ❓ waiting for you, ❌ ended, `·` unknown)
and its item title when cached (no id, no conventional-commit prefix; the workspace name until then), with its number in tab order (`⌥1` to `⌥9`, then `10` and up). Each tab runs its own copy and marks its own tab.
Up/Down or `j`/`k` step to the neighbouring tab, a click picks a row, and a tab's number jumps to it.
A digit that could start a two-digit number waits 0.6 s for a second one, so with 14 tabs `1` then `2`
goes to tab 12 and `1` alone goes to tab 1. If you leave the tab some other way while a digit waits, the digit is dropped.
The legend shows the range the digits reach, such as `1-14`.
Left/Right or `h`/`l` go back and forward through the tabs visited from the sidebar, like a browser.
Every tab's sidebar shares one history per zellij session (`<meta>/sidebar-history/<session>.json`),
tabs closed since are skipped, and a failed switch leaves it as it was. Switches made outside the sidebar
(zellij keys, the tab bar, `overbridge next`, `overbridge go`) are not recorded.
The new tab's sidebar takes focus so stepping continues. The list scrolls to keep the
current tab visible. Long titles wrap under their text (up to three rows).

The sidebar has two frames. The Orchestration frame is on top, lists the orchestration tabs, and does
not scroll. It has one tab, `@root`, which runs Claude in the overbridge root (`$OVERBRIDGE_ROOT`,
`~/workspaces` by default). That Claude coordinates and doesn't do the work itself. It loads the
agent-state hooks and a guard through `claude --settings <meta>/orchestration/@root.settings.json`, and gets
a brief through `--append-system-prompt`. The guard lets it read anything, run read-only `git` and `gh`
commands, check status, and start or remove workspaces. It blocks file edits, branch changes, commits,
pushes, and changes to PRs and issues, and its message tells Claude to start a workspace instead. When you
ask it for a task, it runs `overbridge start` with your request as `--prompt`, and the new workspace's
Claude does the work. The Workspaces frame is below it. Keys,
clicks, and `overbridge next` treat both frames as one list, so `⌥1` goes to the root tab.
Orchestration tab names start with `@`, which a workspace name can't, so an orchestration tab's state
and sidebar files never share a name with a workspace's.

An orchestration tab always stays open. `overbridge rm @root` refuses it, and Cleanup never offers it.
When its Claude session ends, a fresh one starts in the same pane; a session that keeps exiting within
a few seconds waits a little longer each time (up to 30s). When the tab is closed, the next sidebar poll
opens it again at the front and returns focus to the tab you were on. A lock in
`<meta>/orchestration/@root.reopen.lock` makes sure only one sidebar reopens it. A user layout
(`layouts/overbridge.kdl`) decides its own tabs, so nothing is reopened when one exists.

Under the list, up to three rows show workspaces being removed or removed in the last hour (see **Seeing what was
removed** above). Below them, while the [check queue](#check-queue) is busy, a `▶` row shows the running command, its
workspace, and how long it has run, and a `⧗` row lists the workspaces waiting.

The width (default 60) comes from the global config:

```toml
# repos.toml
[sidebar]
width = 60    # 12 to 200
```

`s` opens a one-line prompt at the foot of the sidebar. Type `<repo> <id>`, such as `overbridge 79` or
`web-monorepo ENG-123`. If the tab's workspace holds one repo, the id alone is enough; otherwise the prompt asks for
the repo next. Enter runs `overbridge start`, which opens the item's workspace in a new background tab, or switches to its tab if
it already has one. Esc cancels. While the prompt is open, every key goes into it. If the start fails (unknown repo,
item not found, or a refused claim), the footer shows the error until you press another key.

At the foot sit Claude's usage limits (Hourly = 5-hour window, Weekly), coloured green, yellow or red by
projected usage at reset, and a key legend. Claude's statusline script writes them to
`<meta>/limits.json` as `{"at": <ms>, "fiveHour": {"pct", "resetsAt"}, "weekly": {...}}` (`resetsAt` in epoch
seconds); unknown or over six hours old shows `–`.

`overbridge next` (the `n` key in the sidebar, and a zellij binding) goes to the next tab that needs you:
waiting for input first, then finished, then finished with background tasks running, cycling from the current tab.

`overbridge go <n>|<name>|next|prev` switches tab by its sidebar number (`go 1` is the root tab, like `⌥1`), by name,
or to the neighbouring tab (wrapping), and lands on that tab's Claude pane. It works from outside the session too,
so a window-manager key (say Hyprland `SUPER+ALT+<n>`) can be bound to it: without `$ZELLIJ` it targets the session by
name, `$OVERBRIDGE_SESSION` or `workspaces`.
#### Agent state

Each workspace's `.claude/settings.json` registers `overbridge hook` for `SessionStart`,
`UserPromptSubmit`, `PostToolUse`, `Notification`, `PreCompact`, `Stop` and `SessionEnd`, next to the guard.
It records `empty` (a session just started or cleared; Claude's later idle notification does not turn it into `waiting`, and the workspace becomes a Cleanup candidate if nothing is uncommitted or unpushed), `idle`, `busy`, `waiting`, `done` or `end` (with Claude's SessionEnd `reason`; `/clear` and `/resume` record nothing) in `<meta>/agent/<ws>.json`. On `Stop` it also records the pids of shells still running under the session (background tasks); `done` reads as `bg` while any is alive. Plan-mode plans are written to `<ws>/plans/` (`plansDirectory` in the generated settings), not `~/.claude/plans`.
The root tab's Claude records its state the same way, under its tab name (`<meta>/agent/@root.json`).
The hook
never blocks or fails the agent and loads none of the rest of the CLI. A `busy` state with no
update for 10 minutes (the agent died mid-turn) and any state older than a day show as unknown.
When the top panel's cache is over a minute old, the hook starts one `overbridge top refresh`
in the background, at most once per 30 seconds.

An agent that stops right after an *automatic* compaction (`PreCompact` with trigger `auto`, then `Stop` with no
tool call or prompt between) is restarted: the `Stop` hook blocks the stop once with a "continue where you left off"
reason. Manual `/compact` is left alone.

### Top panel

`overbridge top` is a pane for the top of every tab, in a rounded frame titled with the task name (the
message, e.g. a refresh error, sits in the bottom border): one row per PR, as
status icon, repo, number and title with its actions at the right (**Ready**/**Draft** flips the PR, or every PR of
its stack, between draft and ready for review; **Merge** appears once the PR is green and not a draft, asks for a
second press within five seconds, and merges a stack atomically with `gh stack merge`). Between the PR and its actions sit Copilot and CodeRabbit chips: 🟡 reviewing, 🟢 reviewed, 🔴 changes requested or failed, 💬 (blue, with a count) unresolved review threads that reviewer opened, which win over every other state, 🚫 out of quota (CodeRabbit says when it is back, e.g. `🚫 CodeRabbit 56m`), ⚪ skipped or no review. Copilot has no check of its own, so ⚪ also covers a Copilot out of premium requests, a request never made and a repo without Copilot review: GitHub accepts the request and does nothing, so they look the same, a button for the item. With PR rows showing, the launchers get their own section under an `── actions ──` divider, left-aligned: a toggle per app with its state
(⚫ stopped, 🟡 starting, 🟢 running, 🔴 exited) and port, an editor button (`ide`), and the 🤖 claude / 💻 terminal /
🔀 diff buttons. PR buttons are coloured by status: 🟣 merged, 🟢 mergeable, 🔴 failing build or conflicts,
🟡 build pending, 🔵 blocked (review or behind), ⚫ closed. Claude focuses the agent; terminal opens a shell in
the first repo and diff opens the changes since the default branch (whitespace ignored, rendered by `delta`
from your git config) in a column to the agent's right, and a second press closes them. Click or Enter to
activate, arrows or Tab to move, `o` open a running app, `L` show its log, `r` refresh,
`q` quit. Every button shows its key and the key presses it: `i` the work item, `p` the PR (`u`, `y`, `w`, `z` for more),
`1`-`9` the apps, `e` the editor, `c` `t` `d` claude, terminal and diff, `x` Cleanup. It reads caches and local app records only; `overbridge top refresh` rebuilds
the cache and the panel runs it every minute.

## Extending

overbridge can be extended without a fork. A team or a person can add commands, keep their own settings, and
set up repos they can't commit to.

- **Commands**: `overbridge <name>` runs the first `overbridge-<name>` executable on PATH when `<name>` is not a
  built-in command, the way git runs `git-<name>`. It gets the arguments as given and its exit code is passed on.
  `overbridge help` lists the ones it finds. The command gets these environment variables:
  - **`OVERBRIDGE_ROOT`**: the workspaces root, with symlinks resolved.
  - **`OVERBRIDGE_SELF`**: how to call overbridge back, such as `overbridge` or `/path/to/bun /path/to/cli.ts`.
  - **`OVERBRIDGE_NAME`**: the workspace the caller is bound to, when there is one.
- **Settings**: top-level `x-<name>` keys in `overbridge.yml` or the root `config.yml`. See
  [Extension keys](#extension-keys).
- **Repo setup outside the repo**: the [root `config.yml`](#root-configyml).

A workspace's Claude may run any `overbridge` command (its `.claude/settings.json` allows `Bash(overbridge:*)`), so
that includes every `overbridge-<name>` on PATH. Only put commands on PATH that you are happy for it to run.

## Licence

[MIT](LICENSE)
