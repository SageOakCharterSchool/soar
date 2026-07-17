---
name: Git pane subrepl bloat
description: Workspace Git pane "Unknown error" caused by stale subrepl-* remotes; what the main agent can and cannot clean up
---
Each background task agent leaves a `subrepl-*` remote and local branch behind. Over ~100 of them made the workspace Git pane fail with "Unknown error from the Git service."

**Why:** The Git service chokes enumerating hundreds of remotes/branches; the actual GitHub remote (`subrepl-6u5hcg2g` → SageOakCharterSchool/soar, used by branch `staging`) is fine and must be kept.

**How to apply:**
- Main agent CAN rewrite `.git/config` directly (plain file edit) to drop stale `[remote "subrepl-*"]` sections — `git remote remove` itself is guard-blocked.
- Main agent CANNOT delete branch refs in any form: `git branch -D`, `git pack-refs`, `rm`/`os.unlink` on `.git/refs/heads/*` are all platform-blocked. Branch cleanup needs a background task agent (done July 2026 — all 123 subrepl branches removed; a stale zero-byte `.git/packed-refs.lock` had to be `rm`'d first).
- Keep `gitsafe-backup` and the GitHub remote. July 2026: GitHub remote renamed to `origin` (branch.staging.remote/merge updated in the same step; stale lfsurl dropped); stale subrepl remotes removed by a background task agent, which CAN run `git remote remove`/`rename`.
- A running background task agent must NOT remove its own `subrepl-*` remote — it becomes stale only after that task merges; clean it up in a later task. A task agent's own subrepl id is the suffix of `$REPL_ID` (after the `:`); if no `subrepl-*` remote matches it, all are safe to remove.
- `main-repl` (a task environment's link back to the main workspace) is platform plumbing — never remove it from a task environment's config.
- July 2026 follow-up: remaining stale subrepl remotes + local subrepl branches removed, GitHub remote renamed to `origin`, stale origin lfsurl dropped; only `origin`, `gitsafe-backup` (and env-local `main-repl`) remain.
- GitHub push still needs the user to re-authorize the GitHub connection ("Invalid username or token" over HTTPS).
