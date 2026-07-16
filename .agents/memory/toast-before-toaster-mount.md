---
name: Toasts fired during initial mount were lost
description: Why early toast() calls (e.g. from Login's ssoError effect) never rendered, and the subscription fix
---
`toast()` dispatched from a mount effect that runs before `<Toaster>` subscribes (e.g. Login renders immediately while auth is loading, and sibling `<Toaster>`'s effect runs later) was silently dropped: the dispatch hit an empty listeners array and Toaster kept its stale empty snapshot.

**Fix:** `useToast`'s subscription effect calls `setState(memoryState)` right after pushing its listener, picking up anything dispatched pre-subscription (no-op when unchanged, since memoryState is referentially stable).

**How to apply:** don't remove that `setState(memoryState)` line from `use-toast.ts`; any toast fired from a component's initial mount effect depends on it.
