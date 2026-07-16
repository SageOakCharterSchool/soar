---
name: Orval query-param name collision in api-zod
description: Adding query params to an endpoint that also has path params breaks the api-zod barrel with TS2308.
---
When an OpenAPI operation gains query parameters and already has path
parameters, orval generates a `<Op>Params` TS type (query) in
`generated/types/` that collides with the zod const `<Op>Params` (path)
in `generated/api.ts`, so the `export *` barrel fails typecheck (TS2308).

**Why:** both star-exports surface the same name; orval also re-appends
`export *` lines to `lib/api-zod/src/index.ts` on each codegen run if the
existing lines use different quote style.

**How to apply:** keep index.ts lines single-quoted to match what orval
writes, and add an explicit `export { <Op>Params } from './generated/api'`
line to resolve the ambiguity in favor of the zod schema.
