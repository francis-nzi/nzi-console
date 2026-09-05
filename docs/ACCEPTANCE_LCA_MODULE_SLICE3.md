# LCA/PCF reference module — slice 3: Transport legs · acceptance

Track C (job-family modularization, NZC-024). Companion: `docs/MODEL_FIDELITY_JOB_FAMILIES.md` §2/§6/§7,
`docs/ACCEPTANCE_LCA_MODULE_SLICE1.md` (Model Register), `docs/ACCEPTANCE_LCA_MODULE_SLICE2.md` (Inventory).
Flag: **`job-module-lca`** in `NEXT_PUBLIC_FEATURE_JOB_MODULES` — unchanged, this slice adds surface behind
the same token.

## Scope of this slice

Multi-leg journeys on **transport-module line items only** — EN 15804 modules **A2** (transport to
manufacturer), **A4** (transport to site/user) and **C2** (transport to waste processing). Every other
module is a product/use/end-of-life module, not a transport leg — the command layer rejects a leg on any
other module (`WRONG_MODULE`). Per leg: origin/destination free text, an EN 15804 transport mode, a
distance, and a factor mapping (dataset / manual / unmapped — **no client factor** on this table, see
below). Distance can be **geocoded** (Nominatim, free-text → lat/lng, behind a deterministic staging stub)
or **entered manually** — manual entry is always available and a geocoded estimate stays fully editable
afterwards. **Not in this slice**: leg-level `calculated_kgco2e` (and therefore the line item's cached
`transport_kgco2e`) — both are left at their honest default (null / 0) pending the calc engine (L4); gap-
filling; scenarios; charts; the report manifest.

## Disclosure (unchanged from slice 2, restated because it matters most here)

This slice is built from Francis's description of the live product + `MODEL_FIDELITY_JOB_FAMILIES.md`, not
the live NZI Pro source directly — the local `nzi-pro` checkout this session had access to was an empty git
init. Two concrete places where that shows:

- **The detour multipliers in `MODE_DETOUR_FACTOR`** (`lcaGeocoding.ts`) — a documented **placeholder** set
  (road ×1.3, rail ×1.2, sea ×1.0, air ×1.05, inland water ×1.15, other ×1.2) approximating a routed distance
  from a great-circle one. These are NOT the live app's real `FREIGHT_DEFAULT_FACTORS`
  (`services/lca_transport.py`), which this session could not read. Swap in the real figures when available
  — nothing else about the module's shape changes.
- **No per-mode freight emission-factor quick-picks.** Francis's brief named `FREIGHT_DEFAULT_FACTORS` as a
  per-mode carbon-intensity default the live app offers as a quick pick. Rather than fabricate plausible-
  looking numbers, this slice ships the factor mapping via the **shared** factor library search (same
  `FactorPicker` pattern as line items) plus a manual-value fallback, and leaves the quick-pick as a follow-
  up once the real values are available.

## What's built

- **`packages/contracts/src/jobFamilies.ts`** — `LcaTransportLeg` gains `fromLat`/`fromLng`/`toLat`/`toLng`
  (evidence of what was actually geocoded), `datasetId`/`factorId`/`factorValue`/`notes` (the write-back
  fields, previously only implied), and its `factorSource` is narrowed to `Exclude<LcaFactorSource,
  "client">` — **`lca_transport_legs` has no `client_factor_id` column** (unlike line items), so 'client' is
  not a valid source here; this is a real, pre-existing schema gap (the `factor_source` CHECK constraint on
  the table still lists 'client' as a value, with nowhere to put the id), documented rather than silently
  patched with a new migration. Adds `LcaTransportLegWriteFields` and `lcaTransportModes` (canonical list).
- **`packages/contracts/src/commands.ts`** — `lca.transportLeg.create` / `.update` / `.delete`, permission
  `emissions.data.edit` (reused). Validation: origin/destination required, mode against `lcaTransportModes`,
  distance ≥ 0, factor-source cross-checks (dataset → factorId + datasetId; manual → factorValue) —
  'client' is rejected outright (`INVALID`), matching the missing column.
- **`packages/isolated-backend/src/lcaTransportLegs.ts`** (new) — `listLcaTransportLegs` /
  `listLcaTransportLegsByLineItems` (batched) / `createLcaTransportLeg` / `updateLcaTransportLeg` /
  `deleteLcaTransportLeg`. `requireTransportLineItem` rejects an unknown line item (`NOT_FOUND`) and a
  non-transport module (`WRONG_MODULE`). Every write recomputes the parent line item's cached
  `transport_kgco2e = COALESCE(SUM(legs.calculated_kgco2e),0)` — currently always 0, since no leg yet has
  a `calculated_kgco2e` (L4's job), but the aggregation is real and future-proof. `createLcaTransportLeg`
  auto-assigns the next `leg_order` (`MAX(leg_order)+1`) so the client never manages ordering.
- **`packages/isolated-backend/src/lcaGeocoding.ts`** (new) — `geocodeFreeText` (Nominatim search API, no
  key; a deterministic stub on staging, mirroring `vehicleLookup.ts`'s DVLA pattern exactly — same input,
  same output, no network call), `haversineDistanceKm`, `MODE_DETOUR_FACTOR` (placeholder, see Disclosure),
  `estimateRoutedDistanceKm`, and `geocodeTransportLeg` (geocodes both ends sequentially, stops at the first
  failure, estimates a routed distance). No caching of resolved geocodes on a supplier/site row yet — the
  live model's `origin_supplier_location_id` / `destination_client_site_id` pre-geocoding pattern Francis
  described needs the supplier/client-site library UI, which is out of this slice's scope; every geocode
  today is a fresh free-text lookup (cheap on the deterministic stub, and Nominatim's own usage policy is
  respected — at most two calls per leg, a descriptive User-Agent).
- **`packages/isolated-backend/src/lcaLineItems.ts`** — `listLcaLineItems`/`listLcaLineItemsByAssessments`
  now attach each line item's real `transportLegs` (batched, N+1-safe), replacing the slice-2 `[]`.
- **API routes** — `GET/POST .../line-items/{lineItemId}/transport-legs`, `PATCH/DELETE
  .../transport-legs/{legId}`, and a **non-job-scoped** `POST /api/isolated/lca-geocode` (stateless — no
  tenant data read or written, so it doesn't need a job id in its path, same reasoning as `/api/isolated/
  clients`).
- **`apps/console/app/jobs/lca/LcaWorkspace.tsx`** — each A2/A4/C2 line item in the Inventory gets a
  "Transport legs (N)" toggle; the expanded panel lists legs in order (from/to/mode/distance/source/factor
  status), an add-leg form with a "Estimate distance (geocode)" button (calls `/api/isolated/lca-geocode`,
  prefills distance + marks it geocoded — the distance field stays editable afterwards, and any manual edit
  reverts the source to manual), and the same `FactorPicker`/manual-value pattern as line items (with
  'client' filtered out client-side too, matching the schema).
- **`packages/isolated-backend/seeds/0006_synthetic_lca_transport_legs.sql`** (new) — adds an A4 "Inbound
  tray shipment" line item to job 714's seeded assessment with the same three-leg geocoded journey
  (Ningbo plant → Ningbo port → Felixstowe port → Leeds pack site) as the illustrative `lcaFidelity.ts`
  mock fixture, so the real seed and the fixture tell the same story; plus a single-leg A2 example on job
  715 (pcf) for a second family's coverage. Applied to isolated staging, re-applied to confirm idempotency.
- **e2e** — `tests/e2e/lca-transport-legs.spec.ts` (new, hard-precondition-once-live discipline, one
  conditional skip for the flag not yet being live).

## Gate

| # | Item | Check |
|---|---|---|
| 1 | `createLcaTransportLeg` rejects a line item that isn't A2/A4/C2 (`WRONG_MODULE`), and an unknown line item (`NOT_FOUND`) | `lcaTransportLegs.test.ts` |
| 2 | A blank origin/destination, an unrecognised mode, a dataset factor with no dataset id, and a 'client' factor source are all rejected | `lcaTransportLegs.test.ts` |
| 3 | `createLcaTransportLeg` auto-assigns the next `leg_order`; every write recomputes the parent line's `transport_kgco2e` | `lcaTransportLegs.test.ts` |
| 4 | `updateLcaTransportLeg`/`deleteLcaTransportLeg` reject an unknown leg | `lcaTransportLegs.test.ts` |
| 5 | `listLcaTransportLegs` maps a row in leg order, including a null `calculatedKgco2e` (pending L4) | `lcaTransportLegs.test.ts` |
| 6 | `geocodeFreeText` rejects a too-short query before any network call, returns a deterministic stub on staging (same query → same point, zero network calls), and maps Nominatim's response/429/network-error correctly | `lcaGeocoding.test.ts` |
| 7 | `haversineDistanceKm` matches a known real-world distance within a small tolerance; `estimateRoutedDistanceKm` applies the per-mode detour factor on top | `lcaGeocoding.test.ts` |
| 8 | `geocodeTransportLeg` geocodes both ends and stops at the first failure without a wasted second call | `lcaGeocoding.test.ts` |
| 9 | `npm run typecheck` (all workspaces) · `@nzi/console` build · full unit suites green | ✅ |

## Verification

- `npm run typecheck` (all workspaces) — clean.
- `npm run test -w @nzi/console` — 121 green (unchanged from slice 2; no new client-side pure logic this
  slice needed its own test file — the geocoding math lives server-side and is covered there).
- `packages/isolated-backend` full suite — 281 green (20 new: 9 `lcaTransportLegs.test.ts` + 11
  `lcaGeocoding.test.ts`).
- `npm run build -w @nzi/console` — green.
- No new migration — Phase 0's `0046_lca_assessments` (which created `lca_transport_legs`) already has
  everything this slice reads/writes.
- `packages/isolated-backend/seeds/0006_synthetic_lca_transport_legs.sql` applied to isolated staging and
  re-applied to confirm the `ON CONFLICT DO NOTHING` idempotency; verified in place by direct query (all
  four seeded legs present with the expected shapes, both transport line items' `transport_kgco2e` honestly
  at 0 pending L4).

## Not yet verified — deliberately deferred

- **No human sensory pass on rendered staging** — same reason as slice 2: the flag is not yet live on the
  target. The e2e spec's hard-precondition checks are the strongest verification available until it flips.
- **Real Nominatim call is not exercised in CI/tests** — only the deterministic stub and injected-fetch
  paths are unit-tested (matching `vehicleLookup.ts`'s own precedent of never calling the live DVLA service
  in tests). A one-off manual smoke check against the real Nominatim endpoint has not been run this session.
- **Geocode caching on supplier/site rows** — out of scope for this slice (needs the supplier/client-site
  library UI); every lookup is a fresh free-text query today.

## Flip

Same variable and same readiness as slice 2 — `job-module-lca` in `NEXT_PUBLIC_FEATURE_JOB_MODULES`, already
seeded and ready; the Render dashboard edit + rebuild remains a manual step needing a human with Render
access. `tests/e2e/lca-transport-legs.spec.ts` has one conditional `test.skip` for the flag not yet being
live; delete that one call as part of the flip PR.

## Rollback

Presentational + additive only. Remove `job-module-lca` (or never set it) — `lca`/`pcf` jobs render via
`FamilyWorkspace` exactly as before. No data / schema change; legs already created stay in
`lca_transport_legs`, simply unread while the flag is off. The non-job-scoped `/api/isolated/lca-geocode`
route makes no external call at all unless invoked, and never on staging (stub only).

## Next slices

Per the confirmed order: **L4 — Gap-filling + calc engine + result snapshot + review** (pre-authorized to
build straight through, Francis, 5 Sep 2026) — this is where every leg's `calculated_kgco2e` and every line
item's `transportKgco2e`/`calculatedKgco2e` finally get a real number, and where the assessment's
`total_tco2e` stops being an honest zero. Then **L5 Scenarios**, **L6 Charts**, **L7 Report manifest + PCF
labelling** — L5 onward gets a status check-in before deep build.
