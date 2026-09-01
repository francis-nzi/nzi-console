# UX1 — one data-entry UX (scope→category accordion) · acceptance record

Running record against `docs/ACCEPTANCE_UX1_DATA_ENTRY_ACCORDION.md` + the signed-off prototypes
`docs/prototypes/crp_v3.html` and `docs/prototypes/portal_v3.html` (`docs/prototypes/README.md`), read
alongside `docs/DATA_ENTRY_UX.md` (NZC-046). **The `data-entry-accordion` flag does not flip until every
gate box is ticked and this record is complete.**

## Sequencing (Francis, 1 Sep 2026 — Q-UX1-1 = (b) refined)

Build UX1, re-home B4/B5/S1/S2 into it, then run **one acceptance per area** and flip on the accordion.
The merged adapters' automated journeys stay green in the meantime (no flag needed). The rendered
screen-reader / viewport pass happens **once**, on the accordion.

## Built (increments)

| # | Increment | PR |
|---|-----------|----|
| a-backend | `emissionCategoryTaxonomy` (contracts — 3 Scope 1, 2 Scope 2, 15 Scope 3, verbatim names + `kind`); `0044` `category_code` on `job_scope_rows` + `job_emission_sources` (additive, nullable); `listJobApplicableCategories(db, jobId, audience)` — CRM completeness view (all taxonomy categories for included scopes, `noData` on empties) / portal authorised-only (bucket grants); CRM + portal GET routes | this PR |
| a-ui | `<EmissionEntryForm>` shared component + `emissionEntryForm.ts` field-order spec (fixed 13-field order, progressive disclosure by `kind` — spend group / registration finder, activity smart-search, collapsible monthly, audience gating: portal never sees factor / quality / confidence / lineage). `.nz-ef-*` + `.nz-plate` + `.nz-months` + `.nz-disc` tokens in `@nzi/ui`. Presentational — endpoint wiring is b/c/d. Tests: console 68 (`emissionEntryForm.test.ts` — canonical order, progressive disclosure per kind, audience gating, action sets) | this PR |
| b | CRP `CrpDataEntryAccordion` behind `data-entry-accordion` (flag added to `DataEntryAdapter`, OFF). Scope→category cards from `listJobApplicableCategories(…, "crm")` + `dataEntryAccordion.ts` grouping (`category_code`, else the row's own scope string for legacy `3.x` rows, else a per-scope **Unsorted** bucket — no row is ever dropped). By category / Needs attention lens over the same rows (command-centre exception buttons switch it). Adapters re-homed via `categoryExtras`: spend rollforward + ledger + import under `3.1`, commuting bulk under `3.7`, vehicle bulk under `1.company-vehicles`. `ScopeRowReadModel.categoryCode` surfaced by `listScopeRows`. Flag OFF ⇒ today's loose panels + flat register unchanged. Tests: console 65 (`dataEntryAccordion.test.ts`), isolated-backend 191 (`listScopeRows` surfaces `category_code`) | this PR |
| c-1 | `categoryCode` on the `scope.row.create` / `scope.row.update` write path — taxonomy + scope-consistency validation; auto-derives from a granular Scope 3 scope string. #54 (merged) | ✅ |
| c-2 | Site-as-context `<select>` in the accordion toolbar (`""`=all / `none`=unallocated / site id); "+ Add entry" opens the shared `EmissionEntryForm` (audience `crm`) inline in the category body → `emissionEntryDraftToScopeRow` maps the draft (stamping `categoryCode` + the site-context `siteId`) → `scope.row.create`. `syncEmissionSourceToScope` now stamps `category_code` too (vehicle→`1.company-vehicles`, commuting→`3.7`, granular Scope 3→its scope). `emissionEntryForm.ts` → `emissionEntryModel.ts` (case-collision with the `.tsx`). Existing-row click still opens the current `Editor` drawer (drawer-side `EmissionEntryForm` = later). Tests: console 72 (`emissionEntryForm.test.ts` — draft↔row mapping, spend/client-factor/monthly), isolated-backend 193 (synced-row `category_code`) | this PR |
| d | Portal accordion mirror; re-home the portal spend surface | ⏳ |
| lookup-backend | `vehicleLookup.ts` in `@nzi/isolated-backend` (port of `services/vehicle_lookup.py` + `vehicle_categorization.py`): `lookupVehicleByRegistration` (live DVLA VES when `DVLA_VES_API_KEY` set, deterministic stub on staging), `resolveVehicleFactor` (best-effort Scope 1 match by fuel + class). CRM + portal POST routes. Registration transient — never persisted / logged / echoed. #57 (merged). Tests: isolated-backend 204 | ✅ |
| lookup-ui | Two-step `onLookupRegistration` in `EmissionEntryForm` — look up → confirm card (make · fuel · year · class, suggested factor for CRM) → **Use this** pre-fills activity + factor, or **enter manually**. `CrpDataEntryAccordion` wires it to `/api/isolated/jobs/[jobId]/vehicle-lookup` (composite factor key). Portal wiring lands with `d`. | this PR |
| flip | `data-entry-accordion` into `render.yaml` after the single accordion acceptance | ⏳ |

## Gate status (after a-backend)

| Gate item | State |
|---|---|
| §1 taxonomy — verbatim names, applicable-only, per-category counts (entries · tCO₂e · completeness) | ✅ `emissionCategoryTaxonomy` + `listJobApplicableCategories`; names match the prototypes' `CATS` |
| §1 CRM completeness view — all 15 Scope 3 when Scope 3 is included; empties `noData`, never mandatory, excluded from reports | ✅ read model (report exclusion already holds — empty categories have no rows) |
| §1 portal — authorised categories only (bucket grants), not the full 15 | ✅ `audience:"portal"` filters to active bucket-grant category codes |
| §7 tests | ✅ contracts 38 (taxonomy shape) · isolated-backend 191 (CRM completeness + portal authorised + migration invariant) · console 42 · typecheck · `next build` |
| §6 flag — no flag referenced yet; read model + `0044` inert until the accordion reads them | ✅ applied to isolated staging 01 Sep 2026 (see incident note below) |
| §2–§5, §8 (shared component, accordion, site-context, progressive disclosure, a11y) | ⏳ increments a-ui / b / c / d |

## Rollback

`0044` is additive: `category_code` is nullable, only written by the accordion's entry form; the read model
falls back to `scope` for grouping. With no `data-entry-accordion` flag and no surface reading the taxonomy,
everything is inert and today's flat register + panels are unchanged.

## Incident — 01 Sep 2026: CRP job workspace 503 (`0044` not applied to isolated staging)

`listScopeRows` was widened in UX1b (increment `b`, this record) to select `r.category_code` — but that
select runs for **every** CRP job page, not only the accordion, so "inert until a flagged surface reads it"
(as claimed above and at the `a-backend` gate) was wrong for this specific column read. `0044` had not
actually been applied to the isolated staging database, so every CRP job workspace (`/jobs/[jobId]`) 503'd
with `column "category_code" does not exist` inside `apiFailure`'s generic "Isolated API unavailable"
response — surfaced in the UI as "Workspace unavailable".

**Fix:** applied `0044` to isolated staging directly (`node packages/isolated-backend/scripts/apply-migration.mjs
packages/isolated-backend/migrations/0044_scope_row_category_code.sql`, using the boundary-guarded,
non-production-only connection already in `.env.local`). Verified: `category_code` present on both
`job_scope_rows` and `job_emission_sources`; `SELECT r.scope_row_id, r.category_code FROM
nzi_console.job_scope_rows r` succeeds; the job from the report (`J000717`) is live in the isolated `jobs`
table. No data loss — the migration only adds a nullable column.

**Process gap:** a read-model change that adds a column to an *unconditional* query (used outside the new
flag) needs the migration applied **before that PR's deploy**, not "before the flag flips." `a-backend`'s
own gate said this; `b`'s description didn't re-flag it because the column looked accordion-only. Future
migrations that any always-on read model depends on go in the PR checklist as a pre-deploy step, not a
pre-flip one.
