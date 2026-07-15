---
name: connect-pg-simple bundling pitfall
description: Session table auto-creation fails silently in esbuild-bundled servers
---

connect-pg-simple's `createTableIfMissing: true` reads `table.sql` from its module directory at runtime. In an esbuild-bundled server (single dist file), that file isn't there, so the session table is never created and every login silently fails to persist (cookie is set, but `/me` returns 401).

**Why:** Hit this on the Sage Oak dashboard — sessions worked in theory but the `session` table never existed; no error was logged.

**How to apply:** When using express-session + connect-pg-simple in a bundled server, create the `session` table explicitly at startup (CREATE TABLE IF NOT EXISTS with sid/sess/expire + expire index) and drop the `createTableIfMissing` option.
