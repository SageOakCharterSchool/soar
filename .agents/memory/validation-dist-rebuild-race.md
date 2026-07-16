---
name: Validation dist rebuild race
description: Why the google-sso UI check can flake with MODULE_NOT_FOUND during platform validation
---
The platform validation suite runs `verify-migrations` and `google-sso-ui-check` concurrently. Both touch `artifacts/api-server/dist/`: verify-migrations unconditionally rebuilds the bundle while the SSO check boots a server from the same dist, so worker files (e.g. thread-stream-worker.mjs for pino) can transiently vanish, producing MODULE_NOT_FOUND / "did not become ready".

**Why:** esbuild rewrites dist files mid-boot of the spawned server; the failure is a scheduling race, not a code problem.

**How to apply:** If google-sso-ui-check fails only inside validation with MODULE_NOT_FOUND in dist, rerun it in isolation to confirm it passes, then treat the validation failure as flaky. Also ensure the dev workflows (API server + web) are running — the raci/staff checks hit REPLIT_DEV_DOMAIN and 502 if they're stopped.

Also: running many playwright-core browser checks concurrently in one validation run causes flaky chromium launch failures (D-Bus errors, "browser has been closed") and page.goto timeouts in unrelated checks. A check that passes in isolation is trustworthy despite parallel-run failures.
