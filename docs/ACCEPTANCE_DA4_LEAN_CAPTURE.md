# DA4 — lean capture + drawer refine · acceptance

Track: **M8 · Data Assurance**. Decision **NZC-058**. Flag: **`entry-lean-capture`** in
`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`. Final slice of the DA-track (after DA5/DA1/DA2/DA3).

## What changes

CRM new-entry capture (`EmissionEntryForm`, `mode="new"`, `audience="crm"` — the CRP accordion's "+ Add
entry", the only place a brand-new CRP row is created) becomes **core fields only**, matching the portal's
already-constrained capture model:

- **Kept in capture**: site context (banner), registration finder (reg categories) or activity smart-search,
  quantity + unit, monthly breakdown (optional), spend details (spend categories only).
- **Moved to the row's existing detail drawer** (`.nz-drawer`, unforked — it already carries every one of
  these fields for editing an existing row): quality tier, data confidence, evidence notes, supporting
  documents, factor override, reasoned override, apportionment.
- **Factor** stays visible during capture but becomes **read-only confirmation**, not a required pick — it
  is auto-matched from the typed activity (`matchFactorByActivity`: an exact, trimmed, case-insensitive hit
  against the same factor set the smart-search datalist already suggests) or from the DVLA lookup's
  suggested factor (unchanged). Unmatched shows "No factor matched yet…", not a blocking error.
- **Quality tier / data confidence are left genuinely unset** (`null`) on a lean-captured row, not silently
  defaulted — `blankDraft` seeds `""` for both when lean is active, which `emissionEntryDraftToScopeRow`'s
  existing `?? null` fallback turns into `null`. This matters: the pre-existing `QA_INCOMPLETE` freeze check
  and the DA3c Approve-row gate both key off `quality_tier` being set, so a lean-captured row still forces a
  real visit to the drawer before it can be approved or signed off — nothing is defaulted past that gate.
- Existing-row editing, the portal, and the DVLA lookup path are **all unaffected** — `leanCapture` only
  changes behaviour for `audience==="crm" && mode==="new"`.

### Not built (scoped out honestly)

"Supporting documents" has no working upload anywhere in the app today — the capture form's "dropzone" is,
and always was, a static presentational placeholder, and the row drawer has no file-attach affordance either.
Removing it from lean capture loses no function; it is not asserted as present in the drawer by
`lean-capture.spec.ts` for the same reason — that would test something that doesn't exist.

## Files

- **`apps/console/app/jobs/emissionEntryModel.ts`** — `buildEmissionEntryFields` gains a 4th parameter
  `leanCapture` (pure, defaults to `false`); computes `lean = leanCapture && audience==="crm" && mode==="new"`
  and, when true, swaps the `factor` field's control to `"factor-review"` and drops `qualityTier`,
  `dataConfidence`, `note`, `documents`. New control `"factor-review"` added to `EmissionEntryControl`. New
  pure helper `matchFactorByActivity(activity, factors)`.
- **`apps/console/app/jobs/EmissionEntryForm.tsx`** — new `leanCapture` prop; `blankDraft` takes a `lean` flag
  so quality tier / data confidence seed to `""` (→ `null`) instead of a default tier, only in lean mode; the
  activity smart-search `onChange` auto-sets `factorId` via `matchFactorByActivity` when lean; new
  `"factor-review"` render case (a read-only confirmation banner, reusing `.nz-banner`); a closing hint line
  when lean, naming where the deferred fields now live.
- **`apps/console/app/jobs/CrpDataEntryAccordion.tsx`** — passes
  `leanCapture={dataEntryAdapterEnabled("entry-lean-capture")}` to `EmissionEntryForm`.
- No migration, no new command, no schema change — the drawer that now does the "refine" work
  (`Editor`/`Fields` in `CrpScopeWorkspace.tsx`, opened via the docking `EvidenceDrawer`) already existed and
  already carries every deferred field; DA4 only thins capture.

## Gate

| # | Item | Check |
|---|---|---|
| 1 | A new CRM entry (lean) shows core fields only: site, registration/activity, quantity+unit, monthly, spend details where applicable — no quality tier, data confidence, note or documents field | `emissionEntryModel.test.ts`, `lean-capture.spec.ts` |
| 2 | The factor field is read-only confirmation (`factor-review`), not a required pick; unmatched shows a clear "no factor yet" state, not an error | `lean-capture.spec.ts` |
| 3 | `matchFactorByActivity` matches a listed factor label exactly (trimmed, case-insensitive) and nothing else | `emissionEntryModel.test.ts` |
| 4 | A lean-captured row's quality tier / data confidence are `null`, not defaulted — still visible to the existing `QA_INCOMPLETE` / Approve-row gates | code review (`blankDraft` lean seeding + existing `?? null` mapping); no gate logic changed |
| 5 | Existing-row editing (mode `"existing"`), the portal audience, and `leanCapture=false` (the default) are all byte-for-byte unaffected | `emissionEntryModel.test.ts` |
| 6 | The row's existing detail drawer still carries quality/confidence/evidence-notes for post-save editing — unforked, no new drawer | `lean-capture.spec.ts` |
| 7 | Happy path: accept match → quantity → Save entry creates the row | `lean-capture.spec.ts` |
| 8 | No uncatalogued serious/critical axe violations; no horizontal overflow at the accordion breakpoint | `scanWithBaseline(page, "lean-capture")` + `expectNoHorizontalOverflow` |
| 9 | **Flag hard-precondition** — once the lean shape is present, every check is hard (fail loud, no silent skip). The one conditional skip (flag not yet live) is removed in the flip PR. | `lean-capture.spec.ts` `openLeanCapture` |
| 10 | `npm run typecheck` (all workspaces) · `@nzi/console` build · full unit suites green · flag OFF leaves capture unchanged | ✅ |

## Verification (PR #89)

- `npm run typecheck` (all workspaces) — clean · `npm run build -w @nzi/console` — green.
- `@nzi/console` unit suite — 89/89 (+4 DA4: field-shape lean/non-lean, existing/portal unaffected,
  `matchFactorByActivity`).
- `lean-capture.spec.ts` (4) — skips until `entry-lean-capture` is live; **harden at flip**.

## Flip

Append `entry-lean-capture` to `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` in the Render dashboard + rebuild; add to
`render.yaml`. Harden `lean-capture.spec.ts` (remove the flag skip), run against deployed staging, record here
+ a human pass (screen-reader on the factor-review banner and the hint text; keyboard reaches Save entry
without the removed fields snagging tab order).

## Rollback

Presentational, additive to the field-order spec only. Remove `entry-lean-capture` + rebuild — new-entry
capture renders exactly as before (factor-select, quality tier, data confidence, note, documents all back).
No data / route / schema change — a row created while the flag was on is a completely ordinary scope row
(quality tier/confidence simply `null` until set), editable the same way regardless of the flag's state.

This completes the DA-track (M8): DA5 → DA1 → DA2 → DA3 (a/b/c) → DA4, all built.
