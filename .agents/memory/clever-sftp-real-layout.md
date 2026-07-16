---
name: Clever Reports SFTP real layout
description: What Clever's real Reports SFTP server actually publishes, vs the aggregated snapshot format assumed by earlier mocked tests.
---

Clever's real Reports SFTP (reports-sftp.clever.com, port 22, root dir) does NOT publish aggregated snapshot batches with ExportProperties.csv. It publishes raw per-user daily files:

- `daily-participation/YYYY-MM-DD-daily-participation-{students|teachers|staff}.csv` (columns: date, sis_id|staff_id, clever_user_id, clever_school_id, school_name, active, num_logins, num_resources_accessed)
- `resource-usage/YYYY-MM-DD-resource-usage-{students|teachers|staff}.csv` (adds resource_type, resource_name, resource_id, num_access)
- Also `idm-reports/` and `idm-sensitive-exports/` dirs (empty/ignored).

Only ~13 most recent days are retained on the server. Each date must be aggregated into one snapshot (active counts, login sums, distinct users per app/school; resource_type "app" rows only for app tables). Active flag is the string "True"/"False".

**Why:** Mocked tests were built on an assumed snapshot-batch layout; the first real connection (2026-07-16) revealed the mismatch. Verified real sync end-to-end: imported 11 days, re-run skipped all, aggregates matched manual recomputation from raw files.

**How to apply:** Any change to the SFTP sync or importer must keep the daily-report adapter path working; don't trust the snapshot-batch format as representative of Clever's server.
