---
name: Simulating stale multi-session state in Playwright
description: How to deterministically test optimistic-concurrency conflicts (409 + toast) across two browser sessions
---
To make one session render stale data while another edits, hold that session's refetch requests in-flight with `context.route` (queue `route.continue()` callbacks), rather than `route.abort()`.
**Why:** aborting makes react-query's refetch fail; once retries are exhausted nothing re-triggers the fetch after unrouting, so the session never converges. A held request completes with fresh data the moment it is released — deterministic convergence.
**How to apply:** see `scripts/src/raci-conflict-ui-check.ts` — hold GETs of the matrix endpoint, let admin A edit, click the stale cell in B (409 → conflict toast), then release held routes and assert both sessions show the same value.
