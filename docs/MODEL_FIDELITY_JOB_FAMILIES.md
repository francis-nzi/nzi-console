# NZI Console — Job-Family Model Fidelity Assessment

**Question addressed (Francis, 01 Sep 2026):** NZC-024's direction is confirmed — CRP, Consultancy, LCA,
PCF and Training become **first-class workspace modules** over the shared spine, and the generic
`FamilyWorkspace.tsx` ternary is retired. Before building any module, do a *prove-the-model* pass per
non-CRP family — because their detail models in the console are **placeholders** today. Same shape as
`MODEL_FIDELITY_DATA_ENTRY.md`: schema-level comparison, proposed model + worst-case fixtures + migration,
confirmed as a batch. Then one non-CRP module end-to-end (**LCA first**) as the reference pattern, behind a
flag; replicate. CRP stays canonical and untouched.

**Method.** Live `nzi_pro_v7-POSTGRES` (`nzi-live-fix/` — `sql_migrations/0046–0067`, `api/lca_*_routes.py`,
`api/job_training_routes.py`, `api/job_consultancy_routes.py`, `TRAINING_WORKFLOW_BRIEF.md`) against the
console's `nzi_console.jobs.detail_json` shapes (`packages/contracts` `JobDetail`, `job.create`), the
`@nzi/mock-data` family fixtures (`jobs.ts`, `lca.ts`), and `ARCHITECTURE.md` §6 / `WORKFLOWS.md` §12–13.

---

## 0. Verdict

**The shared spine is done and sound; every non-CRP family's *detail* model has to be built.**

- **Numbering (NZC-025): complete.** `job_number_counter` singleton + `allocate_job_sequence()`
  (`UPDATE … WHERE singleton RETURNING`, row-locked → gapless, concurrency-safe by construction);
  `jobs.sequence` (int) + `job_number` `GENERATED ALWAYS AS 'J'||lpad(sequence,6,'0') STORED`;
  `job_family` CHECK across all five. `createJob` allocates **inside the creating transaction**
  (assign-on-commit); the idempotency test proves a retried create never burns a number; a migration
  schema invariant guards the function. Nothing further needed. *(A live-DB concurrency race test isn't
  possible — the repo mocks all SQL, see the migrations memory — but the allocator's correctness is
  structural, not timing-dependent.)*
- **Shared spine (NZC-024 "shared" column): present.** `jobs` header, `job_stage_history`,
  `jobWorkflowStages` per family (contracts), family-aware `job.stage.change`, `jobFamilyMeta`.
- **Per-family detail: placeholders only.** `jobs.detail_json` carries a thin per-family summary
  (`{assessment, boundary, bomLines, scenarios}` for LCA; `{course, sessions, bookings, attendancePct}`
  for training; `{scope, deliverables[], plannedDays, usedDays}` for consultancy). `@nzi/mock-data/lca.ts`
  has a **richer** `LcaAssessment` / `LcaLineItem` fixture, but it is not in any schema and not wired to a
  workspace.
- **PCF is not a separate model.** Live `0058` merged PCF into `lca_assessments` (`assessment_type`,
  `standard='ISO 14067'`, cradle-to-gate, a PCF-default module set); the old `job_pcf_details` was dropped
  (confirmed never used). The console should follow: **one LCA/PCF model, two presets.**
- **Consultancy is genuinely light.** Live is a single `job_consultancy_details` row. The console's
  placeholder is close; it needs a deliverables/effort model, not an inner engine.
- **Training is the largest** — a full products → runs → sessions → bookings → attendance → entitlements
  engine, plus the one real **cross-family link** (a CRP job's free training place → a training
  entitlement).

So: **three detail models to design** (LCA/PCF, Training, Consultancy), one cross-family link, and each
must plug into the console governance spine (versioned review, provenance/lineage, reviewed snapshot,
evidence drawer, five states, optimistic concurrency) the way CRP scope rows do — the live models mostly
do **not** (plain `review_status` enums, `str()`-repr snapshots).

---

## 1. The shared spine — what a module gets, what it must add

| Construct | Shared (have it) | Per-family (module adds) |
|---|---|---|
| Identity | `jobs` header · `job_number` · `job_family` · client · owner · dates · quote link | — |
| Numbering | `allocate_job_sequence()` — one counter, gapless, txn-scoped | — |
| Workflow | `job_stage_history`; `jobWorkflowStages[family]`; `job.stage.change` | Stage **semantics** (what "Inventory" means for LCA vs "Bookings" for training) + stage-gated validation |
| Detail data | `jobs.detail_json` (summary only) | **Real detail tables** — the module's inner model |
| Factors & datasets | `job_dataset_selections`, `emission_factors`, `client_factors`, provenance | Family-specific **factor mapping** surface (LCA line-item search/gap-fill; training has none) |
| Governance | versioned rows + `expectedVersion`, `provenance`/`lineage`, reviewed snapshots, 5 states, audit, RLS | Apply the **same spine** to the family's atomic unit (LCA line item / training booking) — the live models don't |
| Visualization | `@nzi/charts` engine + brand tokens | Family manifest + chart subset (`TrainingAttendance` already exists; LCA module-breakdown / hotspots charts do not) |
| Report | reviewed-snapshot → manifest → immutable release (CRP) | Family report manifest (EN 15804 module table for LCA; attendance register + certificates for training) |

**Rule (NZC-024):** modules own workflow + detail + pages + manifest; they **must not** fork factors,
charts, provenance, files, tenancy or the evidence drawer.

---

## 2. Deep dive A — LCA / PCF  ◐ **placeholder → design needed (P0 for the reference module)**

### Live model (`0058` rebuild + `0059`–`0067`)

Deliberately **flat, no BOM tree** ("real-world workbooks flatten multi-level BOMs for calculation
anyway"). A job holds **several assessments** (the "Model Register" — e.g. a 6 L vs a 9 L variant).

| Entity | Purpose | Notable fields |
|---|---|---|
| `lca_modules_lookup` | EN 15804 life-cycle modules | `A1`–`A3` (product), `A4`/`A5` (transport/construction), `B1`–`B7` (use), `C1`–`C4` (end-of-life), `D` (benefits); `default_in_pcf` / `default_in_lca`; admin-editable |
| `lca_material_categories_lookup` | material vocabulary | org-scoped; Metal / Plastic / Rubber / Foam / … |
| `lca_components` | **reusable client-scoped component library** (mirrors `custom_factors`' `client_db_id`/global pattern) | `default_unit_mass`, `origin_country`, `supplier_name`, archive lifecycle |
| `lca_assessments` | replaces `lca_products`; **several per job** | `assessment_type` (product/service), functional unit (value + unit), `confirmed_quantity` (for mass reconciliation), `lifecycle_boundary`, `included_modules` (JSONB), `standard`, `review_status`, `total_tco2e`, `last_calculated_at` |
| `lca_assessment_datasets` | dataset selection per assessment | — |
| `lca_line_items` | **flat inventory**, one row per module | `component_id` (library link *or* ad hoc), `module_code`, `quantity`/`unit`, transport (`transport_mode`, `distance_km` — superseded by legs), `energy_kwh`, `end_of_life_route`, factor mapping (`mapped_factor_source` = lookup/custom/manual, `mapped_factor_id`, cached `factor_value`/`unit`/`label`/`url`), `data_quality` (primary/secondary/proxy/estimated), `is_gap_filled` + method, `is_placeholder` (assembly-grouping row, excluded from calc) |
| `lca_transport_legs` (`0061`) | **multi-leg journeys** for A2/A4/C2 line items | ordered legs, each geocoded (`services/geocoding.py`) + haversine + mode detour factor; `transport_emissions_tco2e` cached back onto the line item so read-time aggregation doesn't join |
| factor confidence (`0059`) | trigram match + persisted `factor_match_confidence` + advisory **readiness / data-quality score** per assessment — flags "needs review" lines |
| `lca_supplier_library` (`0062`) | reusable supplier records | — |
| `lca_scenarios` + `lca_scenario_multipliers` | what-if (schema in Phase 1, engine Phase 3) | multiplier keyed by `module_code` + optional `material_category_id` **or** `component_id` (more specific wins); `is_baseline` |
| `lca_result_snapshots` | calc output (real JSONB now, was `str()` reprs) | `module_breakdown`, `hotspots`, `mass_reconciliation` (confirmed vs captured mass) |

### Console gap

- Only the `LcaDetail` header summary (`{assessment, boundary, bomLines, scenarios}`).
- `@nzi/mock-data/lca.ts` has `LcaAssessment` + `LcaLineItem` + transport-leg counts + scenarios +
  `mappingState` + `confidence` — a good starting shape, **not in schema, not wired**.
- No modules/material/component/supplier vocabularies; no calc engine; no readiness score; no
  mass-reconciliation.

### Proposed console model (migration batch)

Adopt the live `0058` shape, **add the governance spine** the live model lacks:

- `nzi_console.lca_modules` (seed EN 15804 A1–D, `default_in_pcf`) · `lca_material_categories` (org-scoped)
  · `lca_components` (client-scoped reusable, archive lifecycle) · `lca_suppliers` (client-scoped).
- `nzi_console.lca_assessments` — `job_id`, `assessment_type`, name/SKU, functional unit, boundary,
  `included_modules`, `standard`, `reference_year`, `geography`, `confirmed_quantity` (+unit),
  **`version` + optimistic concurrency**, `review_status` **bound to a reviewed version** (not a free enum),
  `total_tco2e`, `last_calculated_at`, `provenance_json`.
- `nzi_console.lca_line_items` — flat, per `module_code`; `component_id` nullable; factor mapping via the
  **shared** `emission_factors`/`client_factors` (not a parallel `factor_lookup`); `data_quality`,
  `factor_match_confidence`, `is_gap_filled`, `is_placeholder`; `calculated_kgco2e` + `lineage_json`.
- `nzi_console.lca_transport_legs` — child of a transport line item; ordered; `from`/`to` (address +
  lat/long + geocode source), `mode`, `distance_km`, `distance_source` (geocoded/manual), cached
  `calculated_kgco2e`; parent line caches the leg sum.
- `nzi_console.lca_scenarios` + `lca_scenario_multipliers` — schema now, engine later (mirror live Phase 1).
- `nzi_console.lca_result_snapshots` — content-addressed (`data_hash`), `module_breakdown`, `hotspots`,
  `mass_reconciliation`; the **reviewed snapshot** an LCA report is built from, same discipline as CRP.
- **PCF preset:** `assessment_type='product'`, `standard='ISO 14067'`, `lifecycle_boundary='cradle_to_gate'`,
  `included_modules=['A1','A2','A3']`. No separate tables.

### Worst-case fixtures (`@nzi/mock-data`)

1. **Model Register** — one job, two assessments (6 L vs 9 L variant), shared component library rows.
2. **Multi-leg transport** — an A4 line item: factory (CN) → port (CN) → port (UK) → client site, three
   geocoded legs, one leg mode = sea, one = HGV; cached sum ≠ any single leg.
3. **Unmapped + gap-filled** — a line with `mapped_factor_source='manual'`, `data_quality='proxy'`,
   `is_gap_filled=true`; a second line `is_placeholder=true` (assembly header, zero in the total).
4. **Mass reconciliation mismatch** — `confirmed_quantity` 31.5 kg, captured line mass 28.9 kg → the
   snapshot's `mass_reconciliation` shows the −8 % gap the reviewer must resolve.
5. **Client vs global component** — one `client_db_id`-scoped component, one shared.

---

## 3. Deep dive B — Training  ◐ **placeholder → design needed (largest module)**

### Live model (`0046`–`0048`, `TRAINING_WORKFLOW_BRIEF.md`)

| Entity | Purpose | Notable fields |
|---|---|---|
| `training_products` | **reusable** course catalogue (org-scoped) | `default_hours`, `default_delivery_mode`, `default_capacity`, `default_min_attendees`, `certificate_policy`, `default_documents_json` |
| `training_course_runs` | one delivery of a product, **linked to a job** | own `status` + **`workflow_stage_key`** (setup/…); `total_hours`, `capacity`, `min_attendees`; venue (name/address) **or** online (url/id/passcode); start/end date |
| `training_bookings` | one participant on a run | `participant_type` (external_individual/…); `booking_source`; person name/email/phone; `billing_status` (pending/…); `attendance_status` (booked/…); `consent_status`; `entitlement_id` (free-place link) |
| `training_entitlements` | **free places generated by a CRP job** | `source_job_id` + `source_job_number` + `source_client_db_id`; `entitlement_type='free_place'`; `status` **available → reserved → consumed**; `allocated_to_booking_id`; `reserved_at` / `consumed_at` / `expires_at` |
| `training_course_sessions` | scheduled sessions within a run | date, start/end time, `session_hours`, delivery mode, venue/online, `status` |
| `training_session_attendance` | **per session per booking** | `attendance_status`, `attendance_minutes`; `UNIQUE(session, booking)` |
| `training_automation_log` | reminders / hooks fired | — |

Certificate issuance is policy-driven off aggregate attendance (`certificate_policy` + summed
`attendance_minutes` vs `total_hours`).

### Console gap

`TrainingDetail` header summary only (`{course, sessions, bookings, attendancePct}`). `@nzi/charts`
`TrainingAttendance` exists and `FamilyWorkspace` renders it from the summary — no real bookings, sessions,
entitlements or certificates.

### Proposed console model

- `nzi_console.training_products` (org-scoped, reusable) · `training_course_runs` (`job_id`,
  `training_product_id?`, own stage key, venue/online, capacity/min) with **`version`** ·
  `training_course_sessions` (child of run) · `training_bookings` (child of run;
  person + billing + attendance + consent; `entitlement_id?`) · `training_session_attendance`
  (`UNIQUE(session, booking)`, minutes).
- `nzi_console.training_entitlements` — the **cross-family** table: `source_job_id` FK to a **CRP** job,
  `status` available→reserved→consumed, `allocated_to_booking_id`, atomic transition (a place can't be
  double-consumed — a `SELECT … FOR UPDATE` + status guard, like the numbering allocator).
- `nzi_console.training_certificates` — issued off a policy check against summed attendance; content-hashed
  (a certificate is evidence), links the run + booking; the reviewed artefact a training report cites.
- Governance: a **run** is the versioned unit for stage/review; **bookings** and **attendance** are its
  detail; the reviewed snapshot for a training report freezes the attendance register + certificates.

### Worst-case fixtures

1. **Free-place lifecycle** — a CRP job (`J000712`) generates 3 entitlements; one is reserved then
   consumed by an external booking on a training run for a *different* client; one expires unused.
2. **Partial attendance below threshold** — a booking attends 2 of 3 sessions (240 of 360 min); the
   `certificate_policy` (≥80 %) → **no certificate**, flagged on the register.
3. **Online + in-person mixed run** — a run with 2 online sessions (meeting url/passcode) + 1 in-person
   (venue address).
4. **Over-capacity waitlist** — a run at capacity 12 with 14 bookings; 2 `attendance_status='waitlisted'`.
5. **Billing vs attendance divergence** — `billing_status='invoiced'` but `attendance_status='no_show'`.

---

## 4. Deep dive C — Consultancy  ✓ **near-complete — small design**

### Live model

A single row: `job_consultancy_details` — `engagement_type`, `deliverables` (free text), `workshop_count`,
`hours_budget`, `hours_used`, `next_review_date`, `summary_notes`. No inner engine, no line items, no
time-logs table wired to it.

### Console gap

`ConsultancyDetail` placeholder (`{scope, deliverables[], plannedDays, usedDays}`) is already close.

### Proposal

Keep it lightweight — **do not build a time-tracking engine**:

- `nzi_console.job_consultancy_details` — one versioned row per job: `engagement_type`, `scope`,
  `hours_budget` / `hours_used`, `next_review_date`, `summary_notes`.
- `nzi_console.consultancy_deliverables` — a checklist child table: `title`, `status`
  (planned/in-progress/delivered/accepted), `due_date`, `delivered_at`, optional `file_id` (shared files),
  optional link to a reviewed artefact. This is the consultancy module's only real "detail grid".
- Stage semantics: Scope → Plan → Delivery → Client review → Complete gate on deliverable status.

### Worst-case fixtures

1. A retainer engagement (`engagement_type='retainer'`) over budget (`hours_used` > `hours_budget`).
2. A deliverable `status='delivered'` awaiting client acceptance past `due_date`.
3. A fixed-scope engagement with 5 deliverables, 2 accepted, 1 rejected (needs rework).

---

## 5. The one real cross-family link — CRP → Training entitlement

`crp_job_details.free_training_place` (live) is the only concrete CRP↔Training dependency. In the console:
a **CRP** job (or its quote/commercial terms) can grant N `training_entitlements`; a training booking may
consume one. This shapes both modules and must be in the batch, not bolted on later:

- entitlements are **created** by a CRP-side action (or seeded from the quote), `source_job_id` → CRP job;
- **consumed** by a training booking with an atomic available→consumed transition;
- visible on both workspaces (the CRP job shows "3 training places · 1 used"; the training run shows which
  bookings are entitlement-funded);
- never a hard FK from `training_bookings` to a CRP job — only through the entitlement row, so training
  stays independent of CRP's internals (NZC-024).

---

## 6. Schema-shaping — the batch  **[confirmed 01 Sep 2026]**

All additive, all in `nzi_console`, all on the governance spine (version + provenance + RLS + audit).

| Migration | Contents | Family | Status |
|---|---|---|---|
| `0045_lca_core` | `lca_modules` (seeded A1–D), `lca_material_categories`, `lca_components`, `lca_suppliers` | LCA/PCF | ✅ Phase 0 |
| `0046_lca_assessments` | `lca_assessments` (versioned, review-bound), `lca_assessment_datasets`, `lca_line_items`, `lca_transport_legs` | LCA/PCF | ✅ Phase 0 |
| `0047_lca_scenarios_snapshots` | `lca_scenarios`, `lca_scenario_multipliers`, `lca_result_snapshots` (content-addressed) | LCA/PCF | ✅ Phase 0 |
| `0048_training_core` | `training_products`, `training_course_runs` (versioned), `training_course_sessions`, `training_bookings`, `training_session_attendance` | Training | ✅ Phase 0 |
| `0049_training_entitlements` | `training_entitlements` (CRP→Training), `training_certificates` (content-hashed) | Training + CRP link | ✅ Phase 0 |
| `0050_consultancy` | `job_consultancy_details` (versioned), `consultancy_deliverables` | Consultancy | ✅ Phase 0 |

**Phase 0 complete (1 Sep 2026):** `0045`–`0050` are on `main` (PRs #63 / #64 / #65) and applied to
isolated staging; `@nzi/contracts` family types + `@nzi/mock-data` worst-case fixtures + migration
invariants land with them. No UI.

**Confirmed decisions (Francis, 1 Sep 2026) — registered as NZC-052–056 in `DECISIONS.md`, placed after
the report decisions NZC-048–051 to keep the number line continuous. These carry the wording that was
drafted as `NZC-0aa..0ee` (0aa→052 … 0ee→056):**

- **NZC-052 — LCA/PCF one model, two presets.** PCF is `lca_assessments` with `standard='ISO 14067'` /
  cradle-to-gate / A1–A3; no separate PCF tables (follows live `0058`). **The "Product Carbon Footprint"
  term keeps its one sanctioned home in the PCF preset's UI/report labelling per NZC-039** — the shared
  model does not remove it.
- **NZC-053 — LCA component / supplier libraries are client-scoped or global,** mirroring `client_factors`
  (`client_id` NULL = shared).
- **NZC-054 — LCA inventory is flat.** `lca_line_items` per EN 15804 module, no BOM tree; a multi-leg
  transport journey is `lca_transport_legs` (child of a transport-module line, ordered, geocoded), with the
  parent line caching the leg sum.
- **NZC-055 — family review spine.** A family's atomic reviewed unit (LCA assessment / training run) is
  versioned with `expectedVersion`, carries provenance/lineage, and its `review_status` is **bound to a
  reviewed version** — not the live models' free enums. Family reports are built from a content-addressed
  reviewed snapshot, same as CRP.
- **NZC-056 — CRP↔Training only via entitlements, and factors are shared.** Free training places
  **originate from the quote / commercial terms** (quote → CRP job), with a **manual CRP grant as a
  secondary path**; both create a `training_entitlements` row (available → reserved → consumed, atomic) —
  the only CRP↔Training link, no hard FK. LCA line-item mapping uses the shared `emission_factors` /
  `client_factors` + the provenance signature — no parallel `factor_lookup` / `lca_factor_*` tables.
  Consultancy stays light — **no time-tracking engine**, just `job_consultancy_details` + a deliverable
  checklist.

---

## 7. Build order

1. **Model batch** (§6) — migrations + `@nzi/contracts` types + `@nzi/mock-data` worst-case fixtures +
   migration invariants, **no UI**. *(Mirrors data-entry Phase 0.)* **✅ Done (1 Sep 2026)** — `0045`–`0050`
   on `main` (PRs #63/#64/#65), all applied to isolated staging.
2. **Hold the LCA reference module** until the report (R-track / M7, NZC-048–051) and data-entry (UX1 +
   adapters) tracks land (Francis, 1 Sep 2026). **✅ Both landed 4 Sep 2026** — gate lifted; M9 (fast
   row-adding) inserted ahead of this module per Francis's explicit sequencing, also landed.
3. **LCA reference module** — `apps/console/app/jobs/lca/`: own routing off `job.header.family === "lca"`,
   own stage machine, the assessment register → line-item grid → transport legs → factor mapping →
   recalculate → module breakdown chart → report manifest. Behind a `job-module-lca` flag; `FamilyWorkspace`
   still serves lca when the flag is off. Prove it (acceptance gate, like each B/S slice).
   **Slice 1 (Model Register) built 5 Sep 2026, PR #94** — `docs/ACCEPTANCE_LCA_MODULE_SLICE1.md`. Remaining
   slices (line items + factor mapping, transport legs + geocoding, recalculate + snapshots, charts, report
   manifest) proposed there, awaiting confirmation before deep build — same "propose, don't guess" pattern
   as DA1's baseline model / R5b's Paged.js choice, since transport-leg geocoding is a genuine new
   external-dependency decision.
4. **Retire `FamilyWorkspace` for lca**; extract the shared bits it needs into `@nzi/job-core`
   (header card, stage control, evidence-drawer host) as the reusable module contract.
5. **Training module** on the same pattern (largest — products/runs/sessions/bookings/attendance/
   entitlements/certificates + the CRP link surfaced on both sides).
6. **Consultancy module** (lightest — details + deliverable checklist); then `FamilyWorkspace.tsx` is
   deleted and every family is its own module.

*Prepared 1 Sep 2026. Recorded against NZC-024 (Confirmed 1 Sep 2026); batch decisions registered as
NZC-052–056. Companion to `ARCHITECTURE.md` §6, `WORKFLOWS.md` §12–13, `MODEL_FIDELITY_DATA_ENTRY.md`.
Phase 0 done 1 Sep 2026; the LCA reference module is sequenced after the report (M7) / data-entry tracks
unless focus shifts.*
