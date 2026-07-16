---
name: Google SSO login-page browser check
description: Gotchas learned building the scripted browser check for the login page's Google SSO behavior
---
The `google-sso` validation runs `scripts/src/google-sso-ui-check.ts`, which boots a second api-server bundle with dummy GOOGLE_CLIENT_ID/SECRET on a private port and proxies the browser's auth requests to it via `page.route`.

Playwright/Chromium gotchas hit here:
- **Fulfilled redirects can't be intercepted downstream.** `route.fulfill({status: 302, headers: {location}})` makes the browser follow the redirect, but the follow-up request errors with `net::ERR_ABORTED` even if another route matches it. Capture the server's Location header and fulfill the navigation with a stub page instead of replaying the 302.
- **Radix toasts duplicate their text** into a hidden aria-live announcement, so `getByText(...)` on toast copy matches two elements and fails strict mode — use `.first()`.
- TS doesn't track assignments made inside `page.route` callbacks; a `let` assigned there narrows to `never` at later use — cast at the read site.
