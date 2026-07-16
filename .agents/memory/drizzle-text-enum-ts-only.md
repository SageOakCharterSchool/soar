---
name: Drizzle text enum is TS-only
description: text(col, { enum }) columns are plain text in Postgres; widening to custom values needs no migration
---

Drizzle `text("col", { enum: [...] })` only constrains the TypeScript type — the Postgres column is plain `text` with no CHECK constraint.

**Why:** When sharing-status and RACI value columns had to accept admin-configurable custom values, the fix was just removing the `enum` option from the schema (plus rebuilding lib/db dist); no SQL migration was needed.

**How to apply:** Before writing a migration to "widen an enum", check whether it is a real `pgEnum` or a TS-only `text({ enum })`. Only the former needs SQL. Validate allowed values at the API layer instead.
