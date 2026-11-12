# Code references in findings

For a persona run without `mob-review`. A `mob-review` prompt already carries this rule, in Step 3 of `SKILL.md` beside this file. Change both together.

Any code you cite that is *not* a changed line of this diff must be a markdown link to that line on `main` on GitHub, in `detail`/`suggestion`. That covers code in another repo and unchanged code elsewhere in this repo. Format: `[path/File.kt:42](https://github.com/<owner>/<repo>/blob/main/path/File.kt#L42)`, or `#L42-L50` for a range. Take the line numbers from `origin/main`, never the local checkout, because local clones lag: `git -C <repo> fetch origin main --quiet && git -C <repo> grep -n '<pattern>' origin/main -- <path>`. Get `<owner>/<repo>` from `git -C <repo> remote get-url origin`. For a repo that isn't on GitHub, give plain `path:line` plus the remote URL. Changed lines of the diff stay in `file`/`line`; they aren't on main yet.
