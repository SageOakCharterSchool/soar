---
name: TS project references stale dist
description: api-server typecheck resolves @workspace/db via emitted dist declarations, which go stale
---

Rule: `tsc -p --noEmit` in packages with `references` (api-server → lib/db, lib/api-zod) reads the referenced packages' `dist/*.d.ts`, not their `src`. If a schema export is added to `lib/db/src` without rebuilding, typecheck falsely reports "no exported member".

**Why:** Hit this when registering validation steps — typecheck failed on exports that clearly existed in source; `npx tsc -b lib/db --force` fixed it.

**How to apply:** Before trusting a "missing export from @workspace/db" typecheck error, run `npx tsc -b lib/db lib/api-zod`. The registered `typecheck` validation command already builds refs first — keep that prefix if editing it.
