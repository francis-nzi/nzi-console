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
| a-backend | `emissionCategoryTaxonomy` (contracts — 3 Scope 1, 2 Scope 2, 15 Scope 3, verbatim names + `kind`); `0044` `category_code` on `job_scope_rows` + `job_emission_sources` (additive, nullable); `listJobApplicableCategories(db, jobId, audience)` — CRM completeness view / portal authorised-only; CRM + portal GET routes | #47 ✅ |
| a-ui | `<EmissionEntryForm>` + `emissionEntryModel.ts` field-order spec (fixed 13-field order, progressive disclosure by `kind`, audience gating: portal never sees factor / quality / confidence / lineage). `.nz-ef-*` / `.nz-plate` / `.nz-months` / `.nz-disc` tokens in `@nzi/ui` | #49 ✅ |
| b | CRP `CrpDataEntryAccordion` behind `data-entry-accordion` (flag added to `DataEntryAdapter`, OFF). Scope→category cards from `listJobApplicableCategories(…, "crm")` + `dataEntryAccordion.ts` grouping (`category_code`, else scope, else a per-scope **Unsorted** bucket). By category / Needs attention lens. Adapters re-homed via `categoryExtras`: spend rollforward + ledger + import under `3.1`, commuting bulk under `3.7`, vehicle bulk under `1.company-vehicles`. `ScopeRowReadModel.categoryCode` surfaced by `listScopeRows` | #50 ✅ |
| c-1 | `categoryCode` on the `scope.row.create` / `scope.row.update` write path — taxonomy + scope-consistency validation; auto-derives from a granular Scope 3 scope string | #54 ✅ |
| c-2 | Site-as-context `<select>` in the accordion toolbar; "+ Add entry" opens the shared `EmissionEntryForm` (audience `crm`) inline → `emissionEntryDraftToScopeRow` (stamps `categoryCode` + site-context `siteId`) → `scope.row.create`. `syncEmissionSourceToScope` stamps `category_code` too. `emissionEntryForm.ts` → `emissionEntryModel.ts` | #56 ✅ |
| d-1 | `PortalDataEntryAccordion` behind the flag — groups the client's **authorised** bucket grants into collapsed scope→category sections (`portalEntryGrouping.ts`), re-homes `PortalSpendEntry` + `PortalEntryRecords` per section. `PortalDataEntryBucket.categoryCode` surfaced by `listPortalDataEntryBuckets` | #59 ✅ |
| d-2 | `PortalCategoryEntry` — each portal section's non-spend entry is the shared `EmissionEntryForm` (audience `portal`); one authorised bucket at a time, authorised-factor + site selectors, `emissionEntryDraftToPortalRecord` → `/data-entry-records`, primary action creates + submits. Portal `/vehicle-lookup` wired (spec only, no factor) | #60 ✅ |
| lookup-backend | `vehicleLookup.ts` — `lookupVehicleByRegistration` (live DVLA VES when `DVLA_VES_API_KEY` set, deterministic stub on staging), `resolveVehicleFactor` (best-effort Scope 1 match). CRM + portal POST routes. Registration transient — never persisted / logged / echoed | #57 ✅ |
| lookup-ui | Two-step `onLookupRegistration` in `EmissionEntryForm` — look up → confirm card → **Use this** pre-fills activity + factor, or **enter manually**. `CrpDataEntryAccordion` wires it to `/api/isolated/jobs/[jobId]/vehicle-lookup` | #58 ✅ |
| drawer-edit | Clicking an existing CRP row in the accordion opens the current full-lifecycle `Editor` in the evidence drawer (update → calculate → independent review → history → snapshot). **Deliberately kept** — `EmissionEntryForm` existing-mode is a *review* surface only; the spec's "one shared capture process" requirement is met by Add-entry on both surfaces. Swapping the drawer to the prototype's collapsed review form is a later visual refinement, only if Francis wants it | — kept as-is |
| flip | `data-entry-accordion` into `render.yaml` after the single accordion acceptance | ⏳ **ready — see below** |

## Automated suite (all on `main`, flag OFF)

`npm run typecheck` clean · contracts 39 · isolated-backend 205 · console 81 · `npm run build -w @nzi/console` green. The merged adapters' e2e journeys are unchanged (they don't touch the accordion).

## Flip readiness — the single acceptance run

Everything is built and green with `data-entry-accordion` **OFF**. To flip, on isolated staging with the flag ON (and `portal-spend` / `spend-import` / `commuting` / `vehicle` / `client-factors` also ON so the re-homed adapters render):

**Per re-homed area — confirm it works in its category section, identical outcome to the pre-accordion path:**
- **B4** spend-import CSV — under Purchased Goods and Services (`3.1`).
- **B5** portal-spend — under `3.1` on the portal accordion; submit-to-review still lands in the staff queue.
- **S1** commuting bulk (`3.7`) + vehicle bulk (`1.company-vehicles`); the roll-up row still recomputes; register-synced rows land in their section, not Unsorted.
- **S2** client factors — still managed at client level; the compact CRP panel still lists them; a client-EPD factor is selectable in the accordion's Add-entry form.
- **Add-entry** (CRP) — a new row in each `kind`: manual, fugitive, spend (`3.1`), vehicle (with a stub DVLA lookup), commuting. Site-context stamps `site_id`; `category_code` stamped; row then calculates + reviews unchanged.
- **Add-entry** (portal) — a draft in an authorised category → Submit for review → staff accept → canonical `pending` row (never `approved`).

**Human-only (not Claude Code), once, on the accordion:**
- screen-reader narration of the accordion (expand/collapse, lens toggle, the inline `EmissionEntryForm`, the confirm card);
- contrast eyeball on the scope dots / chips / plate input;
- no horizontal overflow at 390 / 768 / 1280 / 1920;
- reduced-motion.

**Then:** add `data-entry-accordion` (and keep the per-adapter flags) to `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` in `render.yaml`, merge, confirm the deploy, tick the boxes here.

## Gate status

| Gate item | State |
|---|---|
| §1 taxonomy — verbatim names, applicable-only, per-category counts | ✅ |
| §1 CRM completeness view — all 15 Scope 3 when included; empties `noData`, excluded from reports | ✅ |
| §1 portal — authorised categories only (bucket grants) | ✅ |
| §2 site-as-context (CRP selector auto-stamps `site_id`; portal per-bucket site) | ✅ c-2 / d-2 |
| §3 one field order, both surfaces; portal a constrained mirror | ✅ a-ui, enforced by `emissionEntryModel.test.ts` |
| §4 progressive disclosure — spend group / registration finder only where they belong | ✅ a-ui |
| §5 portal multi-row per authorised category | ✅ d-1 / d-2 |
| §7 automated tests + typecheck + build | ✅ (counts above) |
| §6 flag — `data-entry-accordion` gates the container; adapters keep per-domain flags; `0044` applied to isolated staging 01 Sep 2026 | ✅ |
| §8 "No data" neutral / never mandatory | ✅ empty categories render the neutral note, excluded from reports |
| §2–§8 **rendered** a11y / viewport pass on the accordion | ⏳ human-only, on the flip |

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
