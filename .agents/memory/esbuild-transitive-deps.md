---
name: esbuild externalized transitive deps
description: Externalized packages' own deps must be direct dependencies or the bundle fails at boot
---
The api-server esbuild bundle externalizes native/heavy packages (e.g. ssh2). pnpm does not hoist transitive deps, so an externalized package's runtime requires (ssh2 for ssh2-sftp-client) resolve only if listed as a direct dependency of api-server.

**Why:** Bundle built fine but boot failed with MODULE_NOT_FOUND for `ssh2` until it was added explicitly.

**How to apply:** When adding a package that wraps a native/externalized dep, add the underlying dep explicitly too, then verify by building the bundle and booting it (health check), not just by building.
