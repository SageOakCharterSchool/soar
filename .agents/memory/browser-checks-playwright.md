---
name: Browser checks via playwright-core
description: How to run scripted browser-level checks in this Replit env without Playwright's downloaded browsers
---
Playwright's own browser downloads don't fit NixOS here. Instead:
- Install `playwright-core` (no browser download) in `@workspace/scripts`, plus Nix system dependency `chromium`.
- Launch with `chromium.launch({ executablePath: execSync("which chromium"), args: ["--no-sandbox", "--disable-dev-shm-usage"] })` and `ignoreHTTPSErrors: true` against `https://$REPLIT_DEV_DOMAIN`.
**Why:** validation-registered browser checks (e.g. staff-access) must run headless from a shell command, not via the testing subagent.
**How to apply:** see `scripts/src/staff-ui-check.ts` as the working pattern; retry logins on 5xx since workflows may still be restarting when validations run.
