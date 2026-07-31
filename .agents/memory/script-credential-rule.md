---
name: Data-writing scripts credential rule
description: Admin scripts that write real data must not have hardcoded credential fallbacks.
---

Scripts under `scripts/src` that WRITE data via the admin API must read `ADMIN_EMAIL`/`ADMIN_PASSWORD` from the environment with **no hardcoded fallbacks**, and exit with a clear error before login if either is missing.

**Why:** Completion code review rejects hardcoded admin credentials in production-writing tools (it shipped a real admin password in source). Read-only/dev-only checks (e.g. staff-access-check) historically use dev fallbacks and are tolerated, but anything that mutates the real matrix/data is held to the stricter rule.

**How to apply:** When creating a new seed/mutation script, validate env creds up front; pass credentials inline on the command line when executing locally instead of adding defaults to source.
