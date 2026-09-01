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
| b | CRP accordion container + By category / Needs attention toggle; re-home the CRP adapters into sections | ⏳ |
| c | Site-as-context selector + `category_code`/`site_id` auto-allocation on the write paths | ⏳ |
| d | Portal accordion mirror; re-home the portal spend surface | ⏳ |
| lookup | DVLA registration finder ported from `nzi-live-fix/services/vehicle_lookup.py` → `/portal/vehicle-lookup` (real service; external call stubbed behind the flag in staging) | ⏳ |
| flip | `data-entry-accordion` into `render.yaml` after the single accordion acceptance | ⏳ |

## Gate status (after a-backend)

| Gate item | State |
|---|---|
| §1 taxonomy — verbatim names, applicable-only, per-category counts (entries · tCO₂e · completeness) | ✅ `emissionCategoryTaxonomy` + `listJobApplicableCategories`; names match the prototypes' `CATS` |
| §1 CRM completeness view — all 15 Scope 3 when Scope 3 is included; empties `noData`, never mandatory, excluded from reports | ✅ read model (report exclusion already holds — empty categories have no rows) |
| §1 portal — authorised categories only (bucket grants), not the full 15 | ✅ `audience:"portal"` filters to active bucket-grant category codes |
| §7 tests | ✅ contracts 38 (taxonomy shape) · isolated-backend 191 (CRM completeness + portal authorised + migration invariant) · console 42 · typecheck · `next build` |
| §6 flag — no flag referenced yet; read model + `0044` inert until the accordion reads them | ✅ — **apply `0044` to isolated staging before merge** |
| §2–§5, §8 (shared component, accordion, site-context, progressive disclosure, a11y) | ⏳ increments a-ui / b / c / d |

## Rollback

`0044` is additive: `category_code` is nullable, only written by the accordion's entry form; the read model
falls back to `scope` for grouping. With no `data-entry-accordion` flag and no surface reading the taxonomy,
everything is inert and today's flat register + panels are unchanged.
