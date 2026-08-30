# NZI Console — Data-Entry Model Fidelity Assessment

**Question addressed (Francis, 29 Aug 2026):** *before* building the redesigned data-entry surfaces, be
sure the new **canonical data model** can represent real-world intricacies — custom client factors,
site-specific data, and the rest — not just the happy path.

**Method.** Schema/contract-level comparison (not screens) of the live `nzi_pro_v7-POSTGRES`
(`nzi-live-fix/` @ `origin/main 1c74d908`, 28 Aug 2026) against the Console's canonical model:
`packages/contracts/src/commands.ts` (`ScopeRowWriteFields` / `ScopeRowReadModel`, `FactorOption`,
`SiteOption`), the isolated-backend migrations `0001–0032`, and `packages/mock-data`. Live schema read from
the runtime `_ensure_*_schema` definitions in `api/job_scope_data_routes.py`,
`api/job_emission_register_routes.py`, `api/job_custom_factors_routes.py`, `api/custom_factors_routes.py`,
and the sites routes.

---

## 0. Verdict

**Not yet — the current canonical model cannot represent several real-world constructs, and two of them are
exactly the ones raised: custom client factors (entirely absent) and site-specific data (only partly
modelled).** The model's *governance* spine (versioning, provenance, lineage, independent review,
five states, optimistic concurrency) remains ahead of live and should not change. The gaps are all in
*expressiveness of the activity/factor/site data*, and every one is a **schema-level** construct — so it
must be settled **before** the UI is built, per this repo's own warning that retrofitting the schema after
M3/M4 is expensive.

There are **two missing modelled entities** (client factors; a per-entity source register with roll-up
groups) and **~7 missing fields** on the canonical row. None require abandoning the design; they extend it.

---

## 1. The canonical row — field-level fidelity

Live `job_scope_rows` vs Console `ScopeRowWriteFields`/`ScopeRowReadModel`.

| Real-world construct | Live column | Console model | Verdict |
|---|---|---|---|
| Monthly 12-month activity | `month_1..12` | `monthlyActivity: {month,quantity}[]` | **Captured** (NZC-032) |
| Reporting hierarchy | `level_1..4` | `categoryPath` (derived from `scope`, not a stored controlled path) | **Partial** — path is derived, not a stored controlled taxonomy |
| Report label vs column text | `report_label` + `column_text` | `reportLabel` only | **Partial** — no `column_text` (how it heads a report column) |
| Override + reason | `override_tco2e` (via reporting) | `overrideTco2e` + `overrideReason` | **Captured** (NZC-034) |
| Data quality tier | — (different axis) | `qualityTier` (measured/estimated/spend/survey) | **Captured** (Console richer here) |
| **Data confidence H/M/L** | `data_confidence` | ✗ | **Not modelled** — a *second* axis live carries alongside source |
| Data source | `data_source` ('Company Data'…) | free `provenance` JSON only | **Partial** |
| **Apportionment %** | `apply_pct` (default 100) | ✗ | **Not modelled** — can't split one source across sites/periods |
| **As-entered qty/unit (conversion memory)** | `source_qty` / `source_uom` | ✗ | **Not modelled** — storage-mode/unit-conversion memory lost |
| **Asset / reference identifier** | `asset_identifier` | `assetIdentifier` | **Captured** (migration 0033; governed row + snapshot) |
| **Uses a client factor** | `is_custom_entry` | ✗ | **Not modelled** — no client factors exist (see §2) |
| **Row linking / auto rollups** | `linked_row_id`, `is_auto_generated`, `auto_pair_kind` | ✗ | **Not modelled** — needed for commuting/asset roll-ups & consolidation |
| Site assignment | `site_id` | `siteId`/`siteLabel` (+ Unallocated) | **Captured** (assignment only — see §3) |
| Row version + optimistic concurrency | implicit | `version` + `expectedVersion` | **Captured** (ahead of live) |
| Provenance + expandable lineage | partial | mandatory `provenance` + `lineage` | **Captured** (ahead of live) |
| Independent review bound to version | reviewer flags | decision + `reviewedRowVersion` + immutable note | **Captured** (ahead of live) |

**Reading:** the Console governs the row better but *describes* it more thinly. Six construct groups remain
absent at the model level: `data_confidence`, `apply_pct`, `source_qty`/`source_uom`, `is_custom_entry`, the
`linked_row_id`/`is_auto_generated`/`auto_pair_kind` linkage, and `column_text`. The previously identified
`asset_identifier` gap closed in Console migration 0033 (`b057283`).

---

## 2. Deep dive A — Custom client factors  ✗ **Not modelled (P0)**

**Live** carries client-specific factors in **two** tables, so a client's own factor can be reused across
all their jobs *or* pinned to one job:

- `custom_factors` — **client-level**, reusable; and `job_custom_factors` — **job-level**.
- Fields (both): `country` (geography), `scope`, `category`, `description`, `report_label`, `uom`,
  `ghg_unit`, `source`, **`factor`** (the kgCO₂e/unit value), `factor_year` (vintage/version), `custom_id`,
  full `created/updated/archived` audit.
- **Supporting evidence file (EPD):** `source_file_name`, `source_file_storage_provider` (`local` or
  SharePoint), `source_file_external_item_id`, `source_file_external_web_url`, `source_file_path` — a
  manufacturer's EPD PDF backing the factor, stored in the job's document library.
- Scope rows using one are flagged `is_custom_entry = TRUE`.

**Console:** *nothing.* Factors come only from datasets (`FactorOption` = dataset factor). The nearest
construct, the `dataset.override.add` command, adds a **manual dataset** with a reason — it is **not** a
per-factor client value, has **no EPD attachment**, and offers **no client-scoped reuse**. So today a common
real case — "no published factor fits; use the supplier's EPD value" — cannot be represented at all.

**Proposed model.** A first-class `ClientFactor` entity:

```
ClientFactor = {
  id; organisationId; clientId;            // client-scoped, reusable
  jobId?: string | null;                   // optional: pin to one job
  scope; categoryPath; reportLabel; description;
  unit; ghgUnit; kgco2ePerUnit;            // the factor value
  geography;                               // country — feeds the cross-country guard (NZC-011)
  vintageYear; version;                    // versioned like dataset factors
  source; evidence: { fileName; provider; url; hash } | null;  // EPD, hashed into provenance
  archived; audit
}
```

Plus on the row: a `factorSource: "dataset" | "client"` discriminant (replacing bare `factorId`), and the
existing `provenance` must record the client-factor id + **evidence hash** so lineage shows the EPD.

---

## 3. Deep dive B — Site-specific data  ◐ **Partial (P0/P1)**

**Live `client_sites`** is a real place, not just a label: `name`, address-derived creation,
`latitude`/`longitude`/`geocode_source`/`geocode_precision`/`geocoded_at` (geospatial — the portal map),
**`vacated_date`** (site closed mid-reporting-period), and `archived`/`archived_at`/`archived_by`. Rows
carry `site_id`; `apply_pct` lets one source be **apportioned across sites**; factors can be **site-scoped**
("site-scoped factor adds").

**Console `client_sites`** is `organisation_id, site_id, client_id, name, created_by, created_at` — **name
only.** Rows carry `siteId` (FK), so *assignment* works and "Unallocated" is handled. But the model has:

- **no location** (lat/long/geocode) — no site map, no distance-based logic;
- **no lifecycle** (`vacated_date` / active-from) — a site opening or closing mid-year can only be
  *approximated* by leaving months empty, which loses the fact and the reason;
- **no apportionment** (`apply_pct`) — one meter serving two sites can't be split;
- **no site-scoped factors** — a site with its own grid contract / REGO can't override the job factor.

**Proposed model.** Extend `client_sites` with `addressLines`, `postcode`, `latitude`, `longitude`,
`geocodeSource`, `activeFrom`, `vacatedDate`, `archived`; add `applyPct` to the row (see §1); and take an
explicit decision on **site-scoped factor overrides** (a `siteId` on the factor selection).

---

## 4. Structural gap — the per-entity source register  ✗ **Not modelled (P0/P1)**

The biggest structural difference. Live keeps individual **assets, vehicles and employees** in a dedicated
register that **rolls up** into scope rows, rather than forcing each into a scope row:

- `job_emission_sources`: `source_type`/`source_subtype`, `site_id`, `source_name`, `asset_identifier`,
  `employee_name`, dataset/factor, `qty`/`uom`/`factor`, `apply_pct`, `data_confidence`, `notes`,
  **`detail_json` (JSONB)** for kind-specific fields (vehicle reg, commute mode, WFH days/hours, distance
  unit…), `submitted_by_portal`, review status/note, `enabled`, monthly `month_1..12`.
- `job_emission_groups`: groups individual sources and carries the group's dataset/factor for **roll-up**.
- The rolled-up total lands in `job_scope_rows` as an **auto-generated** row (`is_auto_generated`,
  `linked_row_id`, `auto_pair_kind`) — which is why §1 needs those link fields.

**Console:** no register and no groups — everything is a scope row, and the portal bucket has an `entryKind`
enum but stores a single generic `quantity+unit+factor+site+note` record. **This is the data-model home the
typed capture adapters (NZC-035) need.** The Console needs: a per-entity source entity, a grouping/roll-up
concept, a **kind-specific detail store** (typed sub-shapes or a `detailJson`), and the auto-generated
linkage back to the canonical row. Without it, Company Vehicles, per-employee commuting, and the asset
register cannot be represented faithfully.

---

## 5. Things the model already handles well (keep as-is)

Versioned rows + optimistic concurrency; mandatory provenance + expandable lineage; independent review bound
to an exact row version with an immutable note; five explicit states (empty ≠ zero ≠ loading ≠ failed ≠
success); content-addressed reviewed snapshot as the only gate to reporting; monthly vector (NZC-032);
override + reason (NZC-034); dataset factor geography (`emission_factor_datasets.country_code` +
`job_emissions_config.country_code`) as a foundation for the cross-country guard (NZC-011); purchased-goods
categories for Scope 3.1. These are **ahead of live** and are the reason for keeping the spine unchanged.

---

## 6. What to settle before building (proposed decisions)

These are all schema-shaping and should be confirmed as a batch, extending — never weakening — the spine:

1. **Client factors are first-class** (§2): new `ClientFactor` entity, client- and job-scoped, versioned,
   with EPD evidence hashed into provenance; row gains `factorSource` + `is_custom_entry`. **P0.**
2. **Sites are places, not labels** (§3): location + lifecycle (`vacatedDate`/`activeFrom`) on
   `client_sites`; `applyPct` apportionment on the row; decision on site-scoped factor overrides. **P0/P1.**
3. **Adopt a per-entity source register + roll-up groups** (§4) as the home for typed adapters (NZC-035),
   with a kind-specific detail store and auto-generated linkage into the canonical row. **P0/P1.**
4. **Add the remaining row fields** (§1): `data_confidence` (reconciled with `qualityTier`),
   `source_qty`/`source_uom` conversion memory, `column_text`, and
   `linked_row_id`/`is_auto_generated`/`auto_pair_kind`. **P1.** (`asset_identifier` closed in 0033.)
5. **Confirm the taxonomy is stored, not derived** (§1): persist a controlled `level_1..4` path rather than
   deriving `categoryPath` from the `scope` string (tightens NZC-033).

Implementation note (from gap analysis §10.4): all of the above land via **isolated-backend migrations**,
never the live system's request-time `ALTER` pattern.

---

## 7. Recommended way to *prove* fidelity

Extend `ScopeRowWriteFields`/`ScopeRowReadModel` and add the `ClientFactor` + source-register shapes to
`packages/contracts`, then encode **three worst-case fixtures** in `@nzi/mock-data` and assert they
round-trip losslessly through the contract:

- a **client factor** with an EPD file used on a Scope-3 row (`is_custom_entry`, evidence hash in lineage);
- **one energy source split across two sites** via `apply_pct`, with a **mid-year site closure**
  (`vacatedDate` + partial months);
- a **per-employee commuting entry** (vehicle reg + mode + WFH via the detail store) rolling up through a
  group into an **auto-generated** scope row.

If those three serialise and reconcile, the model demonstrably captures the intricacies before any screen is
built.

## 8. Proof — the model now holds the three worst cases (29 Aug 2026)

The proposed extensions were added to `packages/contracts/src/commands.ts`: `ClientFactor`
(+`ClientFactorEvidence`), `ClientSite`, and `EmissionSource`/`EmissionSourceGroup` with a typed
`EmissionSourceDetail` (commuting / vehicle / spend / asset), plus the new **optional** row fields
`factorSource`, `clientFactorId`, `isCustomEntry`, `applyPct`, `dataConfidence`, `sourceQuantity`/
`sourceUnit`, `columnText`, `sourceId`, `linkedRowId`, `isAutoGenerated`, `autoPairKind`. (`assetIdentifier`
was already in the model, so it is not a gap — table above corrected.)

A round-trip test, `packages/contracts/tests/modelFidelity.test.ts`, encodes the three worst-case fixtures
**typed against these contract types** and asserts each survives a JSON round-trip and holds its invariants:

- **A.** a client factor with an EPD file used on a Scope-3 row — `factorSource: "client"`, evidence hash
  carried in `provenance` and lineage;
- **B.** one electricity supply apportioned 60/40 across two sites, one **vacated mid-year** — `applyPct`
  sums to 100 and the vacated site's post-closure months are `null`;
- **C.** a per-employee commuting entry (vehicle reg + mode + WFH via the typed detail) **rolling up** through
  a group into an **auto-generated** scope row — monthly detail reconciles to the annual roll-up.

**Result:** `tsc --noEmit` passes on the repo (the fixtures satisfy the contract types under `strict` +
`noUncheckedIndexedAccess`), and all three runtime tests pass (**3/3**). The canonical model demonstrably
represents the intricacies **before any screen is built**.

*Proof recorded 29 Aug 2026.*

*Prepared 29 Aug 2026 against live `origin/main` @ `1c74d908`. Companion to `GAP_ANALYSIS_DATA_ENTRY.md`.*

## 9. Wired into the repo (29 Aug 2026)

The proven model is now expressed as migration-owned schema, typed sample data, and confirmed decisions:

- **Migrations (isolated-backend; migration-owned, no runtime DDL):**
  - `0034_client_factors.sql` — `client_factors` (client/job-scoped, versioned, with hashed EPD evidence) +
    row `factor_source` / `client_factor_id` / `is_custom_entry`.
  - `0035_client_site_details_and_row_dimensions.sql` — site location + lifecycle (`active_from`,
    `vacated_date`, geocode) + row `apply_pct`, `data_confidence`, `source_quantity`/`source_unit`, `column_text`.
  - `0036_emission_source_register.sql` — `job_emission_groups` + `job_emission_sources` (typed `detail_json`)
    + row roll-up linkage (`source_id`, `linked_row_id`, `is_auto_generated`, `auto_pair_kind`).
  - Covered by new assertions in `packages/isolated-backend/tests/migrations.test.ts`.
- **Typed sample data:** `packages/mock-data/src/fidelity.ts` — the three worst-case fixtures as exports.
- **Decisions:** NZC-041–045 in `DECISIONS.md`. NZC-042's *site-scoped factor overrides* sub-question was
  closed 30 Aug 2026: factors are **not** site-scoped — a site on its own tariff is a per-site row with its
  own factor (`site_id` and `factor_id` are already independent on the canonical row).

**Verification:** `tsc` accepts the extended contract and the mock-data fixtures under `strict` +
`noUncheckedIndexedAccess`; the round-trip test is **3/3**; all three migrations **parse as valid
PostgreSQL** (libpg_query) and their test assertions match. The migrations are **not yet applied to a live
database**; deployment remains a separate controlled step.

*Wiring recorded 29 Aug 2026.*

## 10. Follow-up — monthly activity on the source register (30 Aug 2026)

`emission.source.activity.update` now carries the same **reporting-period monthly vector** as the canonical
row (NZC-032): the isolated backend validates the slots span the job's reporting period in order and derives
the annual roll-up from them, `listJobReportingMonths` feeds the register's editor the period months, and the
CRP source-register editor offers an optional per-month breakdown with copy-first-month-to-all. Covered by
`packages/isolated-backend/tests/postgresCommands.test.ts` (derivation + period-mismatch rejection).

*Recorded 30 Aug 2026.*
