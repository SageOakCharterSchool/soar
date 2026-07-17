---
name: RACI row→application link lifecycle
description: How RACI matrix rows get/lose their application_id link and why board chips can vanish
---

Board chips render purely from `raci_rows.application_id` + assignments; the render path (board endpoint → BoardRow.raci → RaciChips) has never broken.

**Rule:** Any code path that creates applications must (re)link unlinked RACI rows by normalized name; links are otherwise created only once (seed when raci_teams is empty, or manual row create/edit) and never repaired.

**Why:** Links die silently — `raci_rows.application_id` is ON DELETE SET NULL, and a re-imported app list gets new ids, so pre-existing rows stay orphaned forever and chips disappear with no error anywhere. Chips "vanishing" reports are almost always missing links, not UI regressions.

**How to apply:** The usage importer now relinks unlinked rows to newly inserted apps by lower(trim(name)) match. If chips are reported missing again: check `raci_rows` for null application_id whose names fuzzy-match app names, and check for a DB rollback/data-epoch mismatch (compare app names in the user's screenshot against the applications table — names that don't exist at all mean an older dataset).
