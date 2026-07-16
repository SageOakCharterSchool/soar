---
name: RACI empty-state UI checks
description: Gotchas when asserting RACI matrix emptiness in browser checks
---
Empty-state messages that render inside a table body are themselves `<tr>` elements, so a `table tbody tr` count is never 0 on an empty dataset — any "no rows" guard based on that count silently never fires. Subtract the empty-state row (or check for the empty-state text first) before counting data rows.

**Why:** The staff UI check's RACI empty branch could never trigger because "No tasks yet for this team." is a tbody row; this was only caught by exercising the branch live against a seeded empty team.

**How to apply:** When writing Playwright checks that branch on "no rows rendered", detect empty-state texts first and exclude them from row counts. The RACI page has two distinct empty states: "No RACI data yet." (no teams, truly fresh DB — not a table at all) and "No tasks yet for this team." (team with no rows — a tbody row). The staff UI check now seeds a temporary "E2E Empty Team" (high sort_order so it never becomes the default tab) via direct SQL every run, asserts the empty branch against it, and deletes it in a finally block — the branch can no longer rot silently. `RACI_TEAM_NAME=<team>` still lets you focus any other team tab manually.
