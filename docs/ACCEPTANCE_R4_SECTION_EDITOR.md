# R4 — in-place report section editing + Regenerate · acceptance

Spec: `docs/REPORT_PRINTING_UX.md` §2. Decision **NZC-048**. Fourth Report Studio slice; sits on R2
(section model), R3 (figure tokens) and R1.

**Flag:** `report-edit` in `NEXT_PUBLIC_FEATURE_REPORT_STUDIO`. OFF by default → the job's Report & publish
stage is unchanged (validate/publish only). ON → an **Editable sections** panel appears above the release
control.

## What R4 delivers

1. **Working-sections editor** — `CrpReportSectionEditor` in the CRP **Report & publish** stage
   (`stage-report-publish`). Reads `GET /api/isolated/jobs/{id}/report-sections` →
   `ReportSectionEditorScreen`: the ordered sections plus the job's **live (unreviewed) figures** (scope
   totals, target, intensity denominator) for token previews. Five explicit states — loading / failed
   (retry) / degraded (some figures not yet resolvable) / success; an unsaved edit is a distinct visual
   state (the source pill flips to "Unsaved edit").
2. **Rich-text editing scoped to the body.** "Edit text" makes the section body `contentEditable`; the
   figure chips inside are `contenteditable="false"` and cannot be altered or deleted mid-word. Save →
   `report.section.edit` with the body run through `serializeReportSectionBody` (chips collapsed back to
   `<span data-token="KEY"></span>` markers, all editor markup/attributes/`<script>` stripped). Cancel
   reverts. Structural furniture (headings, the pill, the actions) is not editable.
3. **Regenerate (AI).** `report.section.regenerate` → the section's deterministic AI-variant wording
   (`crpReportSectionCatalogue[*].aiBodyHtml`, still data-bound by the same token palette), `content_source
   = ai`, versioned + history. *A live model call is a deliberate follow-up — it needs an Anthropic client,
   an API key on Render and the grounding contract designed; this keeps the `ai` source real without an LLM
   dependency.*
4. **Reset to default** — `report.section.reset` (R2), always available unless the section is still the
   untouched template.
5. **Provenance** — every save/regenerate/reset is an optimistic-locked versioned command appending an
   immutable `report_section_versions` row; the pill shows the current source (Default template /
   AI-drafted / Edited by client) and `vN · actor`.

## Gate

Behind `report-edit` ON, on isolated staging, a staff user on a CRP job's Report & publish stage:

| # | Item | Check |
|---|---|---|
| 1 | Six `.nz-report-section-row`s, each with a source pill + Edit / Regenerate / Reset | e2e |
| 2 | Figure chips resolved from the live job figures; no `.unresolved` when target + intensity are set | e2e |
| 3 | "Edit text" → a `role="textbox"`; tokens inside are `contenteditable="false"`; Cancel restores the read view | e2e |
| 4 | Save → `report.section.edit`; body stored as `<span data-token>` markers, no baked figure value, no editor markup | `serializeReportSectionBody` unit + `report.section.edit` unit |
| 5 | Regenerate → `content_source = ai`, the AI variant body, a new version + history | `packages/isolated-backend/tests/reportSections.test.ts` |
| 6 | `serializeReportSectionBody` round-trips a rendered body and strips `<script>`/class/style/contenteditable/stray tags | `packages/contracts/tests/reportTokens.test.ts` |
| 7 | Optimistic lock — a stale `expectedVersion` on edit/regenerate/reset is a `VersionConflictError` | isolated-backend unit |
| 8 | No uncatalogued serious/critical axe violations on the editor | `scanWithBaseline(page, "report-section-editor")` |
| 9 | `npm run typecheck` · `@nzi/console` build · full suites green · **flag OFF leaves the Report & publish stage unchanged** | ✅ |
| 10 | **Human-only:** screen-reader on the editable body + locked chips; reduced-motion; keyboard — Tab reaches Edit/Save/Cancel, focus lands in the body on Edit, chips are skipped; the edited wording freezes correctly into the next reviewed snapshot | ⏳ Francis |

## Automated suite

- `packages/contracts/tests/reportTokens.test.ts` — +2 (`serializeReportSectionBody` + edit round-trip).
- `packages/isolated-backend/tests/reportSections.test.ts` — +3 (`regenerateReportSection`).
- `apps/console/tests/e2e/report-section-editor.spec.ts` — 2 tests. Skips until `report-edit` is live —
  **harden it in the flip PR**.

## Pre-flip verification (Claude Code, this branch)

- `npm run typecheck` — clean.
- `npm run build -w @nzi/console` — green (routes `/api/isolated/jobs/[jobId]/report-sections`,
  `/api/isolated/reports/sections/regenerate`).
- `@nzi/contracts` 57/57 · `@nzi/isolated-backend` 222/222 · console 81/81 · `test:staff` 33/33 ·
  `test:portal` 89/89.
- R1 + stage-sections e2e still green against deployed staging.
- Rendered verification of the editor is deferred to the flip run
  (`report-section-editor.spec.ts` against deployed staging) — same as R1 was before its flip.

## Flip

Append `report-edit` to `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` (with `report-tokens`, which R4's rendering does
**not** require but the report *version* page does) in the Render dashboard + rebuild; add to `render.yaml`.
Harden `report-section-editor.spec.ts`, run against deployed staging, record here + the human pass in
`docs/STAGING_ACCEPTANCE_R4.md`.

## Rollback

Presentational, additive. Remove `report-edit` + rebuild — the Report & publish stage renders as before. No
data/route/schema change (the `report_sections` tables and commands are inert without callers).

## Follow-up

Live-model Regenerate (Anthropic client + Render key + grounding contract) — a separate decision, tracked
against NZC-048.
