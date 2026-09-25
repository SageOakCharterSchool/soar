---
name: Shared sparkline time axes
description: Time-series mini charts for resources must share one snapshot-date domain.
---

Resource sparklines should use the full shared snapshot-date list rather than each resource's sparse point list. Missing resource snapshots must remain null gaps instead of being converted to zero usage.

**Why:** Independent categorical domains make lines appear to start and end on different dates, while zero-filling would imply usage was measured and found to be zero.

**How to apply:** Pass each resource's history through the shared snapshot dates, use an explicit x-axis, and keep missing points disconnected.