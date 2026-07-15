---
name: api-server fake-db test pattern
description: Gotchas when extending the in-memory drizzle fake used by api-server vitest suites
---
The api-server integration tests mock `@workspace/db` with a hand-rolled in-memory fake (one copy per test file, duplicated across suites).

**Rules learned the hard way:**
- Selects must return **row copies**, not live references — routes that snapshot a row "before" an update (to diff for activity logging) silently see no changes otherwise.
- Aggregate selects (`sql count/sum`) without `groupBy` must collapse all rows into a single group, or count queries return per-row 1s.
- When a new table is added to the schema, it must be added to **every** test file's `@workspace/db` mock — a missing export makes unrelated routes 500 with an HTML error page ("Unexpected token '<'" JSON parse failures in tests are usually this).
- `lib/db` is a composite TS project; if `tsc` claims a table "has no exported member", its `dist/` declarations are stale — rebuild with `npx tsc -b lib/db`.

**Why:** the fake is duplicated in `routes.test.ts`, `status-routes.test.ts`, and `importer.test.ts`; drift between them and the real drizzle API is the main source of confusing failures.
