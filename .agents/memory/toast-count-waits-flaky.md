---
name: Count-based toast waits are flaky
description: Why waiting for a toast by counting same-title toasts fails in Playwright checks, and what to do instead
---
# Count-based toast waits are flaky

Waiting for a new toast by comparing `getByText(title).count()` against a "before" count fails when:
- The toast list is at TOAST_LIMIT (3 in the dashboard): adding a new toast dismisses the oldest, so the visible count never exceeds "before".
- Radix toasts auto-dismiss after ~5s: a polling loop can burn its whole timeout, and by the time a follow-up text assertion runs the toast is gone.

**How to apply:** Prefer waiting on text unique to the new toast (its description), and start that `waitFor` promise *before* triggering the action. Pair it with `page.waitForResponse` on the mutating request to distinguish "no toast" from "no request sent" (e.g. an unaccepted `window.confirm`).
