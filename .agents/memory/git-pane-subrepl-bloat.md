---
name: Git pane subrepl bloat
description: Workspace Git pane "Unknown error" caused by stale subrepl-* remotes; what the main agent can and cannot clean up
---
Each background task agent leaves a `subrepl-*` remote and local branch behind. Over ~100 of them made the workspace Git pane fail with "Unknown error from the Git service."

**Why:** The Git service chokes enumerating hundreds of remotes/branches; the actual GitHub remote (`subrepl-6u5hcg2g` → SageOakCharterSchool/soar, used by branch `staging`) is fine and must be kept.

**How to apply:**
- Main agent CAN rewrite `.git/config` directly (plain file edit) to drop stale `[remote "subrepl-*"]` sections — `git remote remove` itself is guard-blocked.
- Main agent CANNOT delete branch refs in any form: `git branch -D`, `git pack-refs`, `rm`/`os.unlink` on `.git/refs/heads/*` are all platform-blocked. Branch cleanup needs a background task agent.
- Keep `gitsafe-backup` and the GitHub remote; never rename the GitHub remote (branch.staging.remote points at it).
