# R2 — report section model + provenance · acceptance

Spec: `docs/REPORT_PRINTING_UX.md` §2, §5. Decision **NZC-048**. Second slice of the Report Studio
(R-track); sits on R1 (`report-svg-charts`, live).

**Scope (per `docs/REDESIGN_ROLLOUT.md`): "backend/model; no new editing UI."** R2 lands the data model,
versioning, provenance, the `edit` / `reset` commands and the snapshot freeze. The in-place rich-text
editor and AI *Regenerate* are **R4** (`report-edit`); rendering the sections into the report surface
follows with R4. R2 changes nothing a user sees.

**Flag:** `report-sections` in `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` — reserved for the R4 UI. R2 itself is
inert-until-read: the section model is additive and the snapshot always freezes the current section text
(content-addressed provenance, per §5), so there is nothing to gate at R2.

## What R2 delivers

1. **Ordered, versioned sections.** A CRP report is an ordered list of narrative sections. The **default
   wording is code** (`@nzi/contracts` `crpReportSectionCatalogue` — 6 sections: executive summary, net
   zero commitment, background, intensity analysis, category analysis, reduction actions). A working row
   in `report_sections` exists only once a section is edited or explicitly reset; an untouched section
   resolves to its template at `version: 0`.
2. **Provenance, recoverable like a scope row.** Every change appends an immutable
   `report_section_versions` row (who, when, `content_source`, body). `content_source` is
   `default` / `ai` / `client-edited`. `report_sections` is never hard-deleted; the history table is
   `REVOKE UPDATE, DELETE`.
3. **Commands (API, no UI):**
   - `report.section.edit` — optimistic-locked on `version` (0 = first edit); sets body + `content_source`
     (`client-edited` by default, `ai` accepted for R4's Regenerate); appends history.
   - `report.section.reset` — restores the code template + `content_source = default`, bumps the version,
     appends history. A no-op at `version 0` (already the template).
   - Routes: `POST /api/isolated/reports/sections/edit` · `/reset` (permission `reports.publish`).
4. **Snapshot freeze.** `report.snapshot.create` embeds `sections` (the resolved section read model) in the
   content-addressed payload alongside numbers and chart source data, so a re-print of a version is bound
   to exactly the section text signed off. The read models (`getCrpReportVersion`,
   `listReviewedCrpSnapshots`, `getCurrentPublishedCrpReport`) expose `snapshot.sections`; a pre-R2
   snapshot with no `sections` key falls back to the template set.

## Migration

`0051_report_sections.sql` — `report_sections` (working, one row per job × section_key) +
`report_section_versions` (append-only history). Both RLS `FORCE` + `tenant_isolation`, composite tenant
FKs to `jobs`, `content_source` CHECK, `UNIQUE (org, job_id, section_key, version)`. Additive; nothing on
the currently-deployed code reads it. **Applied to isolated staging 4 Sep 2026** (tables + policies
verified).

## Gate

| # | Item | Check |
|---|---|---|
| 1 | Catalogue integrity — unique keys, ascending distinct ordinals, safe default HTML | `packages/contracts/tests/reportSections.test.ts` |
| 2 | `resolveReportSections` — untouched report → template set at v0, in order; working rows overlay | contracts test |
| 3 | `report.section.edit` — first edit inserts v1 `client-edited` + history; subsequent edits update + bump; `ai` recorded; stale version → `VersionConflictError`; non-CRP job rejected | `packages/isolated-backend/tests/reportSections.test.ts` (7) |
| 4 | `report.section.reset` — no row → idempotent no-op at v0; edited section → template body at a new version + history | isolated-backend test |
| 5 | Command validation — unknown section, empty/oversized body, `<script>`/`on*=`, bad version rejected | contracts test |
| 6 | Migration invariants — versioned, tenant-isolated, history-immutable | `packages/isolated-backend/tests/migrations.test.ts` (0051) |
| 7 | Snapshot payload includes `sections`; read models expose `snapshot.sections` with a pre-R2 fallback | isolated-backend + typecheck |
| 8 | `npm run typecheck` · `@nzi/console` build · full test suites green · **flag OFF and ON both render the report exactly as today** (R2 has no UI) | ✅ |
| 9 | Migration applied clean to isolated staging | ✅ 4 Sep 2026 |

## Verification (Claude Code, this branch)

- `npm run typecheck` — clean across all workspaces.
- `npm run build -w @nzi/console` — green (routes `/api/isolated/reports/sections/{edit,reset}` registered).
- `@nzi/contracts` 46/46 (5 new) · `@nzi/isolated-backend` 219/219 (7 new + 0051 invariant) · console 81/81
  · `test:portal` 88/89 (the 1 failure — `guards every portal mutation endpoint` — is pre-existing on
  `main`, unrelated to R2) · `test:staff` 33/33.
- Migration applied to isolated staging and the two tables + RLS policies verified.
- R1 e2e (`report-print-safe.spec.ts`) still green against deployed staging.

## Rollback

Additive and inert. The migration tables are unused by deployed code until R4; leave them in place (no data
loss). The `sections` payload field and read-model field are additive and tolerated as absent. No route or
behaviour depends on them yet.

## Next

R3 (data-bound figure tokens) resolves the figures inside the section prose from the snapshot; R4 adds the
in-place editor + AI Regenerate and renders the sections into the report surface behind `report-sections`.
