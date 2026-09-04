# R3 — data-bound report figure tokens · acceptance

Spec: `docs/REPORT_PRINTING_UX.md` §3. Decision **NZC-049**. Third Report Studio (R-track) slice; sits on
R2 (section model) and R1 (`report-svg-charts`).

**Flag:** `report-tokens` in `NEXT_PUBLIC_FEATURE_REPORT_STUDIO`. OFF by default → the report version page
renders exactly as it did after R1 (hardcoded Executive Summary paragraph, no section list). ON → the
ordered R2 sections render into the report with their figures resolved as locked chips.

## What R3 delivers

1. **Token catalogue + resolver** (`@nzi/contracts` `reportTokens.ts`). 15 tokens across totals, scope
   shares, targets, intensity and dates. `resolveReportToken(key, snapshot)` computes each value straight
   from the reviewed snapshot (`measurements`, `target`, `intensityTarget`, `reportingYear`) and returns
   `{ value, ok, detail }`. When the snapshot does not carry the data a token needs it is
   `{ ok: false, value: "—" }` — never a guess.
2. **Locked-chip renderer.** A figure lives in a stored section body as `<span data-token="KEY"></span>`.
   `renderReportSectionBody(bodyHtml, snapshot)` replaces each marker with
   `<span class="nz-fig-token" data-token="KEY" title="…">108.15 tCO₂e</span>` (value and tooltip HTML-escaped),
   leaving the prose around it untouched. Unresolved tokens render with an `unresolved` marker. `locked`
   option adds `contenteditable="false"` for R4's editor.
3. **Token-embedded templates.** The 6 CRP section templates in `crpReportSectionCatalogue` now carry
   `data-token` markers where a figure belongs (total, scope subtotals & %, baseline, interim %/year, net
   zero year, reporting year, intensity value/unit).
4. **Section rendering.** Behind `report-tokens`, `/reports/[versionId]` renders `snapshot.sections` as an
   ordered list — title, a content-source pill (Default template / AI-drafted / Edited by client), and the
   token-resolved body. Read-only in R3; the in-place editor is R4.
5. **Integrity check extended to the narrative.** `verifyReportSectionTokens(sections, snapshot)` checks
   every `data-token` in every section resolves. The report data-integrity banner now covers charts **and**
   narrative figures ("every chart figure (N) and every narrative figure (M) matches Outputs"), and a
   failure is a distinct `role="alert"` banner. `data-report-ready` is `"true"` only when the manifest
   validates, every chart figure reconciles **and** every narrative figure resolves.

## Gate

Behind `report-tokens` ON (with `report-svg-charts` ON), on isolated staging, a staff user opening a CRP
report version:

| # | Item | Check |
|---|---|---|
| 1 | Six ordered `.nz-report-section`s render, each with a `.nz-section-source` pill | e2e |
| 2 | Every `.nz-fig-token` chip carries a resolved value; **zero** `.nz-fig-token.unresolved` | e2e |
| 3 | The canonical total appears as a chip in the executive summary, matching Outputs | e2e + `verify` unit |
| 4 | Integrity banner green, mentions "narrative figure"; `data-report-ready="true"` | e2e |
| 5 | `resolveReportToken` unit coverage — totals/shares/targets/intensity; unresolved never guesses; renderer is injection-safe; catalogue tokens all in the palette | `packages/contracts/tests/reportTokens.test.ts` (7) |
| 6 | No uncatalogued serious/critical axe violations; no horizontal overflow 390/768/1280/1920 | `scanWithBaseline(page, "report-figure-tokens")` + overflow |
| 7 | `npm run typecheck` · `@nzi/console` build · full suites green · **flag OFF renders the report as after R1** | ✅ |
| 8 | **Human-only:** screen-reader announces the section headings, source pills and the figure chips sensibly; print output shows plain figures (chips unstyled in `@media print`) | ⏳ Francis |

## Automated suite

- `packages/contracts/tests/reportTokens.test.ts` — 7 tests (gate #5).
- `apps/console/tests/e2e/report-figure-tokens.spec.ts` — 2 tests (gate #1–#4, #6). Conditionally skips
  until `report-tokens` is live on the target (`.report-sections` absent) — **harden this (remove the skip)
  as part of the flip PR**, as was done for `report-print-safe` / `stage-sections`.

## Pre-flip verification (Claude Code, this branch)

- `npm run typecheck` — clean.
- `npm run build -w @nzi/console` — green.
- `@nzi/contracts` 53/53 (7 new) · `@nzi/isolated-backend` 219/219 · console 81/81.
- R1 e2e still green against deployed staging (banner text change tolerated).
- Rendered verification of the section list + resolved chips is deferred to the flip run
  (`report-figure-tokens.spec.ts` against deployed staging) — same as R1 was before its flip.

## Flip

Append `report-tokens` to `NEXT_PUBLIC_FEATURE_REPORT_STUDIO` in the Render dashboard (+ rebuild); add it to
`render.yaml`. Harden `report-figure-tokens.spec.ts`, run it against deployed staging, record here + the
human pass, in `docs/STAGING_ACCEPTANCE_R3.md`.

## Rollback

Presentational, purely additive. Remove `report-tokens` + rebuild — the report renders as after R1. No
data, route or schema change. (The token-embedded section templates are inert unless `report-tokens`
renders them or a snapshot froze them.)
