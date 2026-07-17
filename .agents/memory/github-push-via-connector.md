---
name: GitHub push via Replit connector token
description: How to push to GitHub when the Git pane / account-level GitHub auth is broken
---
When the workspace Git pane shows UNAUTHENTICATED and `git push` to GitHub fails with "Invalid username or token", the Replit GitHub **connector** (integrations system) can provide a working token even when the account-level "Connected services" flow fails for the user.

**Why:** The connector token (from `listConnections('github')[0].settings.access_token`) has `repo` scope with push permission to SageOakCharterSchool/soar; the Git pane uses a separate credential path that was broken.

**How to apply:**
- Wire the connection: `addIntegration` + `proposeIntegration` on the GitHub connection, then read the token via `listConnections('github')`.
- Push over HTTPS with username `x-access-token` and the token as password (temp GIT_ASKPASS script; never print the token, delete the temp files after).
- **LFS gotcha:** the repo has LFS files, and the remotes' `lfsurl` points at the Replit ssh proxy, so a plain push hangs/fails on "Permission denied (password,publickey)". Push with `-c lfs.url=https://github.com/<owner>/<repo>.git/info/lfs -c lfs.locksverify=false` so LFS objects upload to GitHub.
- Verify with `git ls-remote` (same askpass) — remote tip must equal local tip.
