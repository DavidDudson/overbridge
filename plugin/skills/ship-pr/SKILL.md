---
name: ship-pr
description: Commit, push and open (or update) a GitHub PR from an overbridge workspace, then record the PR against the workspace. Use when the user says "ship it", "open a PR", "raise a PR", "push this up", or "update the PR" inside an overbridge workspace.
---

# Ship a PR from a workspace

1. **Check state.** `overbridge status` — confirm the repo has a claimed branch (not
   detached, not the default branch). If on the default branch or detached,
   ask for a branch name and run `overbridge checkout <repo> <branch>` first; changes carry over.
2. **Review the diff.** `git -C <repo> status` and `git -C <repo> diff`. Do not
   commit secrets, `.env` files, or build output. Run the repo's checks and fix failures:
   `overbridge config get commands.<name>` (from the repo dir) prints the command its
   `overbridge.yml` declares for `lint`, `typecheck`, `test`, `build` and `format`, and exits
   non-zero when unset. Run the ones that exist; when none are declared, fall back to what the
   repo documents (`just check`, `bun test`, `cargo clippy && cargo test`, …).
3. **Commit.** Conventional Commits subject (≤ 50 chars), body explains why.
4. **Push.** `git -C <repo> push -u origin HEAD`.
5. **PR.** Ask before creating it. Then, from inside the repo dir:
   ```sh
   gh pr create --fill          # or --title/--body; add --draft if work in progress
   ```
   If a PR already exists for the branch, pushing updated it; skip creation.

   **Stacked branch?** If `overbridge status` shows a `stack` entry, replace steps 4–5 with
   `gh stack submit --auto` from the repo dir (still ask first): it pushes every
   layer and opens or updates one PR per layer.
6. **Record it.** `overbridge pr <repo>` so `overbridge status` and claim checks know the PR
   belongs to this workspace.
7. Report the PR URL (`gh pr view --json url -q .url`).
