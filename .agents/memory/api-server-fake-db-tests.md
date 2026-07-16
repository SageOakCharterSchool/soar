---
name: api-server fake-db test pattern
description: Gotchas when extending the shared in-memory drizzle fake used by api-server vitest suites
---
The api-server integration tests mock `@workspace/db` with a shared in-memory fake in `artifacts/api-server/src/test/fakeDb.ts` (single source; test files mock `drizzle-orm`, `@workspace/db`, and `connect-pg-simple` via async `vi.mock` factories that dynamic-import it).

**Rules learned the hard way:**
- Selects must return **row copies**, not live references — routes that snapshot a row "before" an update (to diff for activity logging) silently see no changes otherwise.
- Aggregate selects (`sql count/sum`) without `groupBy` must collapse all rows into a single group, or count queries return per-row 1s.
- When a new table is added to the schema, add it to the `tables` map in the shared fake (one place) — a missing export makes unrelated routes 500 with an HTML error page ("Unexpected token '<'" JSON parse failures in tests are usually this). A drift guard test (`src/test/fakeDb-drift.test.ts`) now compares the real schema's `Table` exports against the fake's `tables` keys and fails loudly on mismatch; that guard file must never mock `@workspace/db`.
- `lib/db` is a composite TS project; if `tsc` claims a table "has no exported member", its `dist/` declarations are stale — rebuild with `npx tsc -b lib/db`.
- The fake only implements the drizzle operators it has needed so far (`eq/ne/gte/lte/lt/isNull`, `onConflictDoUpdate/DoNothing`); a route using a new operator silently mis-filters or crashes — add it to both the `Cond` union/`matches` and `drizzleOrmMock`.
- `vi.hoisted` cannot import helpers; the workaround is async `vi.mock` factories with `await import(...)` of a real (unmocked) module.
- fakeDb onConflictDoUpdate requires `target` as a column *array*; passing a single column crashes routes only under tests (HTML 500 instead of JSON). Real drizzle accepts both — use arrays.
