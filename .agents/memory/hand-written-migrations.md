---
name: Hand-written drizzle migrations
description: drizzle-kit generate is broken in this repo; write migrations by hand
---
`drizzle-kit generate` fails here with `ENOENT .//home/...` (path bug with the absolute `out` dir, plus snapshots are missing for migrations after 0000, so a regenerated diff would be wrong anyway).

**Why:** migrations 0001+ were hand-written; only `0000_snapshot.json` exists.

**How to apply:** for schema changes, edit `lib/db/src/schema/*`, then hand-write an idempotent SQL file in `lib/db/migrations/` (keep `--> statement-breakpoint` markers) and append an entry to `meta/_journal.json` (next idx, version "7", any increasing `when`). Verify with `pnpm --filter @workspace/scripts verify-migrations`, and rebuild `lib/db` dist (`npx tsc -b lib/db`) so typecheck sees new columns.
