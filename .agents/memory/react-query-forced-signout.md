---
name: Forcing sign-out via react-query cache
description: queryClient.clear()+invalidateQueries alone didn't return the app to the login screen after server-side session death.
---
After killing a session server-side (e.g. self-service account deletion), calling `queryClient.clear()` and/or `invalidateQueries()` did NOT reliably make the current-user query go undefined — the dashboard stayed mounted and the login screen never appeared (browser check timed out waiting for the Sign in button; /auth/me was never refetched).

**Rule:** synchronously null the cached user first, then clear:
```ts
queryClient.setQueryData(getGetCurrentUserQueryKey(), null);
queryClient.clear();
```
**Why:** setQueryData renders the logged-out state deterministically; any later /auth/me refetch gets a 401 and keeps the user signed out.
**How to apply:** any flow that ends the session outside the normal logout mutation (account deletion, forced expiry) in the dashboard.
