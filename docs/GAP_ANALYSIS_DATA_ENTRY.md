# NZI Console — Data-Entry Gap Analysis (CRP + Client Portal)

**Part 1 of the redesign gap-analysis series.** A code-level comparison of **data entry and
supporting functionality** between the live platform (`nzi_pro_v7-POSTGRES`, held in-repo under
`nzi-live-fix/`) and the redesigned **NZI Console**, across the two surfaces Francis named: the
**consultant CRP workspace** and the **client portal**. It inventories what the live system does,
maps it to what the Console currently implements, flags every parity gap with a severity, and makes
opinionated recommendations for reducing on-screen noise, optimising the workspaces, and adding
automation.

**Method.** Read-only inspection of both codebases on 28 Aug 2026: the live FastAPI route layer
(`nzi-live-fix/api/*.py`), the live consultant front-end (`nzi-live-fix/frontend/src/...`) and client
portal (`nzi-live-fix/portal/src/...`), against the Console app (`apps/console/...`), its contracts
(`packages/contracts`), isolated backend and mock data. Cross-referenced with `docs/WORKFLOWS.md`,
`docs/ARCHITECTURE.md`, `docs/DECISIONS.md` and `docs/DEVELOPMENT_PLAN.md`.

**Status legend.** **[PARITY]** Console matches or improves on live · **[PARTIAL]** exists but
materially thinner · **[GAP]** live capability absent from the Console · **[NEW]** Console capability
with no live equivalent. Severity: **P0** parity-critical (a consultant/client cannot do real work
without it) · **P1** important (workaround exists but painful) · **P2** quality-of-life.

**Framing note.** The Console is deliberately phased (`DEVELOPMENT_PLAN.md`): **M1 Client portal** and
**M2 Core CRP workflow** are implemented; **M3 Staff workspaces** and **M4 Additional services** are
planned. Many gaps below are therefore *not yet built* rather than *designed out* — but several touch
the canonical data model (monthly granularity, the scope-row hierarchy, override capture, per-kind
portal entry) and should be resolved **before** M3/M4 harden the schema, because retrofitting them later
is expensive. Those are called out explicitly and collected in **§7 (decisions needing Francis)**.

---

## Contents

1. Executive summary
2. Part A — CRP consultant data entry
3. Part B — Client portal data entry
4. Part C — UI/UX: reducing noise & optimising workspaces
5. Part D — Automation & AI opportunities
6. Part E — Prioritised gap register
7. Decisions — confirmed 28 Aug 2026
8. Recommended next increments
9. Appendix — evidence (files & endpoints)

---

## 1. Executive summary

The Console's data-entry **spine is excellent and, in several respects, ahead of the live system**: one
canonical versioned scope row (NZC-008), mandatory provenance and calculation lineage in the evidence
drawer (NZC-005), first-class data-quality tiers (NZC-010), five explicit UI states (empty ≠ zero ≠
failed), optimistic concurrency with `expectedVersion`, an independent review decision bound to an exact
row version, and a content-addressed reviewed snapshot as the only gate to reporting. This is a genuinely
better *governance* model than the live platform, and it should be preserved without compromise.

The gaps are almost entirely about **breadth of ingestion and the shape of the activity data**, not
about governance. Concretely:

- **The live consultant "Data Entry" is eight sections; the Console is one flat register.** Live splits
  work across Data Entry, Employee Commuting, Asset Register, Business Travel, Custom Dataset, Client
  Factors, Spend Data and Notes (`nzi-live-fix/frontend/src/app/jobs/[jobId]/data-entry/[section]/page.tsx`).
  The Console implements the equivalent of *Data Entry* only (`apps/console/app/jobs/CrpScopeWorkspace.tsx`).
  Spend ingestion, employee commuting, the asset/source register with grouping, the business-travel
  workbook, custom (client) factors, per-row notes and per-entity activity history are **absent**.

- **The live scope row is richer than the Console row.** Live `job_scope_rows` carry a
  **level_1..4 hierarchy**, `report_label`/`column_text`, **12-month monthly values**, a **data-confidence
  tier (H/M/L)**, working-site, notes, and an **override with mandatory reason**. The Console row is
  `scope` (a free-text string) + `sourceLabel` + quantity/unit/factor + quality tier + site + (for 3.1)
  purchased-goods category. The **monthly dimension, the reporting hierarchy/label, the override input,
  and per-row notes are the four most consequential missing fields.**

- **Bulk and re-work operations are missing.** Live has repoint-to-different-factor, consolidate,
  bulk-review, a pending-review queue, duplicate-key detection and previous-year row reuse. The Console
  reviews and edits **one row at a time**.

- **The client portal is narrower than live in both directions.** Live portal data entry has three
  distinct capture modes — **buckets (with monthly breakdown), spend (VAT/GL code + AI categorisation),
  and commuting (vehicle registration, mode, WFH days, monthly)** plus vehicle-reg lookup — inside an
  11-area portal (Dashboard, Portfolio, Data Entry, Metrics, Strategy, Risk, Governance, SRS Readiness,
  Reports, Insights, Files). The Console portal renders **one generic quantity+unit+factor+site+note
  record for every bucket kind** and a 4-tab workspace. Its *governance* of client entry (grants, expiry
  windows, submit-to-review, optimistic concurrency) is excellent and ahead of live; its *data capture
  richness and automations* are not there yet.

- **The automations that make the live system fast are not yet carried over:** spend AI categorisation
  (`suggest-categories-bulk`, confirm), vehicle-registration → factor lookup, previous-year rollforward
  of rows and spend mappings, Excel/CSV round-trip with preflight, top/frequently-used factor
  suggestions, and duplicate detection. Automated dataset selection (NZC-030) is the one automation the
  Console already embodies.

**Thesis for the redesign.** Keep the Console's governance spine exactly as-is. Treat the eight live
sections not as eight tabs to recreate but as **one canonical register with typed capture adapters**
(manual, spend, commuting, vehicle, import) feeding it, and **fold the noise into progressive
disclosure**: an exception-first register, inline monthly expansion, editing in the evidence drawer,
bulk actions, and a single shared factor picker. Add automation as **grounded, advisory, consultant-
confirmed** helpers on top of that one model, never as a second write path.

---

## 2. Part A — CRP consultant data entry

### 2.0 The surface, side by side

**Live** (`.../data-entry/[section]/page.tsx`) presents eight sub-tabs under a job's Data group, each a
substantial component:

| Live section | Component (lines) | Purpose |
|---|---|---|
| Data Entry | `JobDataEntry.tsx` (3,425) | The scope-row grid: monthly input, column manager, confidence, audit, template rows, reuse-previous-year, review |
| Employee Commuting | `EmployeeCommutingData.tsx` (1,962) | Survey/workbook upload **and** direct entry by vehicle, monthly breakdown, scale-to-headcount, review |
| Asset Register | `JobSourceRegister.tsx` (1,622) | Individual Scope-1 assets (vehicles/equipment) → **grouped** for roll-up; reg-plate lookup |
| Business Travel | `JobSourceRegister.tsx` | Workbook download → prior-year factor compare → import into Data Entry |
| Custom Dataset | `JobCustomDataset.tsx` (529) | Job-specific dataset construction |
| Client Factors | `JobCustomFactors.tsx` (853) | Client-specific emission factors + supporting EPD file upload |
| Spend Data | `SpendDataCollection.tsx` (1,206) | Ledger spend → map to factor (AI suggested) → sync to scope |
| Notes | `JobNotesSummary.tsx` (799) | Job-wide notes, filterable by scope/site/source/author |

Plus two cross-cutting pieces on every section: **`ActivityHistoryModal`** (per-entity audit trail) and
**`PendingPortalSourceSubmissions`** (client portal submissions awaiting acceptance into the register).

**Console** (`apps/console/app/jobs/CrpScopeWorkspace.tsx`, 724 lines) presents **one page**: a command
centre (readiness ring, metrics, gate list), configuration panels (reduction-pathway target, intensity
target, sites, purchased-goods categories, datasets), and **one emissions-source register** with an
evidence-drawer editor. It maps to the live *Data Entry* section only; the other seven have no equivalent
yet.

### 2.1 The canonical scope row — field-level parity

Live `job_scope_rows` (per `docs/WORKFLOWS.md` §4.4) vs Console `ScopeRowWriteFields` / `ScopeRowReadModel`
(`packages/contracts/src/commands.ts`):

| Field / capability | Live | Console | Status | Sev |
|---|---|---|---|---|
| scope | structured | free-text string, regex `1｜2｜3.x` | [PARTIAL] | P1 |
| level_1..4 classification hierarchy | ✅ | ✗ (only `sourceLabel`) | [GAP] | **P0** |
| report_label / column_text (how it appears in the report) | ✅ | ✗ | [GAP] | **P0** |
| qty / uom | ✅ | ✅ `quantity`/`unit` | [PARITY] | — |
| **monthly values (12-month breakdown)** | ✅ (Complete 12/12 … Empty 0/12) | ✗ (single annual quantity) | [GAP] | **P0** |
| dataset_id / factor_db_id / original_id / factor / ghg_unit | ✅ | ✅ `datasetId`/`factorId`/`factorVersion`/`factorLabel` | [PARITY] | — |
| calc_tco2e | ✅ | ✅ `calculatedTco2e` (deterministic, with lineage) | [PARITY]/[NEW] | — |
| **override_tco2e + override_reason (mandatory)** | ✅ | model has `overrideTco2e`/`overrideReason` but **no UI to set them** | [GAP] | **P0** |
| enabled (counts in total) | ✅ | ✅ `enabled` | [PARITY] | — |
| data confidence tier (H/M/L) | ✅ | quality tier (Measured/Estimated/Spend/Survey) — different axis | [PARTIAL] | P1 |
| working-site assignment | ✅ | ✅ `siteId`/`siteLabel` (+ "Unallocated") | [PARITY] | — |
| purchased-goods category (Scope 3.1) | via level hierarchy | ✅ dedicated controlled list | [NEW] | — |
| per-row notes | ✅ | ✗ (only `reviewerNote`) | [GAP] | P1 |
| storage mode / storage factor (unit conversion memory) | ✅ | ✗ | [GAP] | P2 |
| row version + optimistic concurrency | implicit | ✅ `version` + `expectedVersion` | [NEW] | — |
| independent review bound to row version | reviewer flags | ✅ decision + `reviewedRowVersion` + immutable note | [NEW] | — |
| provenance + expandable calculation lineage | partial | ✅ mandatory in evidence drawer | [NEW] | — |

**Reading of this table.** The Console *governs* the row better than live but *describes* it more thinly.
The four **P0** gaps are structural, not cosmetic:

- **Monthly granularity.** Live captures activity per month (the grid shows 12/12 vs partial vs empty per
  row) and `services/monthly_emissions.py` distributes emissions monthly. The Console stores a single
  annual `quantity`. This affects mid-year site openings/closures, seasonality charts, and portal
  monthly capture — and it is a *schema* decision, so it must be settled before M3. **Recommendation:**
  model activity as an optional 12-slot monthly vector on the row with an annual roll-up, entered via an
  inline expander in the drawer (not a wide always-on grid).

- **Reporting hierarchy & label.** Live rows carry `level_1..4` + `report_label`/`column_text`; the report
  breakdown and chart categories derive from that hierarchy. The Console has only `sourceLabel` + a
  free-text `scope`. Without a structured category path and an explicit report label, the report's
  scope/category breakdown cannot be derived deterministically. **Recommendation:** add a controlled
  category path (per scope) + an explicit `reportLabel`, defaulting label from the factor but overridable.

- **Override with reason.** `override_tco2e`/`override_reason` exist in the *read* model and lineage, but
  the drawer `Editor` exposes no override input — a consultant cannot currently override a calculated
  figure with an audited reason. Given "overrides are first-class and reasoned" is an architecture
  principle (ARCHITECTURE §5), this is an omission in the write path. **Recommendation:** add an
  override field + mandatory reason to the drawer, reusing the existing `postBrowserCommandWithReason`
  pattern already used for manual dataset additions.

- **Free-text scope string.** `scope` is validated only by regex and typed by hand in the editor
  (`<input>`), which invites "one term, three meanings" drift (the exact trap `DECISIONS.md` NZC-003/
  ARCHITECTURE §2.3 warns about). **Recommendation:** replace with a scope selector + category path.

### 2.2 Ingestion paths — parity

Live converges many ingestion routes onto scope rows (`docs/WORKFLOWS.md` §4.3). The Console has manual
entry only.

| Ingestion path | Live endpoint(s) | Console | Status | Sev |
|---|---|---|---|---|
| Manual scope row | `POST /jobs/{id}/scope-data` | ✅ `POST /isolated/jobs/{id}/scope-rows` | [PARITY] | — |
| **Excel round-trip** (template → preflight → import/commit) | `excel-template`, `excel-import-preflight`, `excel-import`, `excel-upload` (`job_setup_routes.py`) | ✗ | [GAP] | **P0** |
| **Spend-based Scope 3** (upload → preview → commit → map → AI suggest → approve → **sync-to-scope**) | `spend_data_routes.py` (18 endpoints) | ✗ | [GAP] | **P0** |
| **Employee commuting** (workbook + direct-by-vehicle + monthly + scale-to-headcount) | `employee_commuting_routes.py` (12 endpoints) | ✗ | [GAP] | **P0** |
| **Company Vehicles** register (was Asset Register; individual assets → groups → roll-up; non-vehicle assets → Data Entry, NZC-037) | `job_emission_register_routes.py`, `JobSourceRegister.tsx` | ✗ | [GAP] | P1 |
| **Business-travel workbook** (download → prior-year compare → import) | `JobSourceRegister` (business_travel) | ✗ | [GAP] | P1 |
| **Client/custom factors** (client-specific factor + EPD file) | `job_custom_factors_routes.py` (7 endpoints) | ✗ (factors are dataset-only) | [GAP] | **P0** |
| **Custom dataset** (job-specific dataset) | `JobCustomDataset.tsx` | ✗ | [GAP] | P2 |
| **Previous-year reuse / rollforward** (rows + spend mappings) | `previous-scope-rows`, spend `rollforward` | ✗ | [GAP] | **P0** |
| Add rows from template / top factors | `template-factors[/top]`, "Add rows from template" | partial (factors limited to selected datasets) | [PARTIAL] | P1 |
| **Portal → register bridge** (accept client submissions) | `PendingPortalSourceSubmissions` on each Data-Entry section | exists, but in the **Platform** workspace (`decidePortalDataEntryReview`), not surfaced in the CRP job workspace; imports generic values | [PARTIAL] | P1 |

Three of these deserve emphasis:

- **Spend-based Scope 3 is a whole workflow, not a form.** Live: upload a ledger, preview, commit rows,
  get an **AI category suggestion** per line (and bulk), a consultant confirms/maps each to a factor,
  approve suggested mappings, **roll forward** last year's mappings, then **sync-to-scope** to
  materialise spend into scope rows carrying the *Spend-based* quality tier. For many clients this is the
  bulk of Scope 3. Its absence is the single largest CRP data-entry gap.

- **Client factors** unblock the common "no dataset factor fits" case (e.g. a supplier EPD). Live lets a
  consultant add a client-specific factor with a supporting file and use it on rows. The Console can only
  pick factors from selected datasets, so any client-specific factor is currently impossible.

- **Previous-year reuse** is what makes a *renewal* fast (most CRP jobs are renewals — `is_renewal` in
  `crp_job_details`). Live copies last year's scope-row structure and spend mappings forward. Without it,
  every renewal is re-keyed from scratch.

### 2.3 Row operations, QA & audit

| Capability | Live | Console | Status | Sev |
|---|---|---|---|---|
| Per-row calculate with lineage | ✅ | ✅ (deterministic, resets on edit) | [PARITY]/[NEW] | — |
| **Repoint row to a different factor** (re-derive) | `POST .../{row}/repoint` | editing factor + recalculate approximates it; no first-class repoint preserving history | [PARTIAL] | P1 |
| **Consolidate / normalise rows** | `POST .../consolidate` | ✗ | [GAP] | P1 |
| Review one row (approve/reject + note) | ✅ | ✅ bound to exact version, immutable note | [PARITY]/[NEW] | — |
| **Bulk review** | `bulk-review` | ✗ (one at a time) | [GAP] | P1 |
| **Pending-review queue** | `scope-data/pending-review` | derived counts only, no filtered queue view | [PARTIAL] | P1 |
| Scope totals | `scope-totals` endpoint | computed client-side | [PARITY] | — |
| **Duplicate-key detection** | ✅ ("Duplicate keys / key groups") | ✗ | [GAP] | P1 |
| **Per-entity activity history / audit** | `ActivityHistoryModal` | audit events exist (`/isolated/audit-events`) but no per-row history UI | [PARTIAL] | P1 |
| Notes with scope/site/source filters | `JobNotesSummary` | ✗ | [GAP] | P1 |
| Reviewed snapshot (content-addressed, QA-gated) | snapshot exists | ✅ rejects incomplete/stale evidence | [NEW] | — |

### 2.4 Scope configuration & intensity

- **Scope configuration.** Live `PUT /jobs/{id}/scope-config` decides, per scope, `include_scope`,
  `dataset_id`, and `factor_method` — "the single most important upstream decision" (`WORKFLOWS.md` §4.2).
  The Console's `DatasetPanel` lets a consultant *add datasets* (with reason, per NZC-030) but there is no
  explicit **include/exclude Scope 1/2/3** decision or **factor-method** choice per scope. **Status
  [PARTIAL], P1.** Recommendation: add an explicit scope-config step (which scopes are in play + method),
  feeding the automatic dataset selection.

- **Intensity.** Live computes intensity per £turnover / employee / m² from `crp_job_details`
  (`job_intensity_routes.py`). The Console's `IntensityPanel` captures a manual denominator + baseline +
  reduction target. **Status [PARTIAL], P2** — the Console models the *target* well but doesn't pull the
  denominator from client/job facts, so intensity isn't auto-derived. Recommendation: default the
  denominator from client turnover/headcount/floor-area, keep manual override.

---

### 2.5 Bulk upload & download identity (confirmed — NZC-036/037)

Bulk entry is standardised across **three quantity-template domains — Employee Commuting, Company Vehicles
(renamed from Asset Register, NZC-037), and Business Travel — all with monthly input**, on both the CRP and
portal, feeding canonical scope rows through the one review workflow. **Purchased Goods & Services is
spend-based**, not a quantity template: it is captured through the **spend adapter** (ledger/invoice upload
→ AI-assisted categorisation → factor mapping → sync to **Scope 3.1** rows tagged with the controlled PG&S
category, NZC-033), which is itself a bulk upload supporting monthly. The spend template is therefore the
fourth canonical download and adopts the same identity block below.

**Three input methods, one validation engine.** Confirmed direction: (1) a **hardened Excel round-trip**
as the offline baseline; (2) an **in-browser paste-and-validate grid** as the fast path (paste from any
sheet, live unit/factor/month/duplicate validation, then commit — no file round-trip); (3) a **remembered
CSV column-mapper** for clients who send their own export (map columns once, remembered per client).
Pull-data **connectors** (accounting, telematics/fuel-card, HR/payroll) are noted as later automation. All
three share one preflight/validation engine and one canonical schema, so they cannot diverge.

**Why this matters now — the live system already drifts.** A shared builder exists
(`services/download_filenames.py` → `{JobNumber} {ClientName} {Descriptor} {StartYear}-{EndYear}.xlsx`),
but at least three others diverge from it: the single-sheet generator builds its own
`{job_no} {client} {site} {year}.xlsx`, `job_setup_routes.py` has a separate `"_".join(...)`, and
`portal_spend_routes.py` hardcodes `spend-data-template.xlsx`. Worse, upload preflight validates the job by
**scanning the filename for a 4-digit year** (`job_setup_routes.py` ~L826-849) — fragile and spoofable.

**The standard (NZC-036).** One shared download service for every template/export, CRP and portal:

- **Filename (human label):** `{JobNumber}_{ClientName}_{JobName}_{ReportingYear}_{Descriptor}.xlsx`
  (underscores, each identifier sanitised) — e.g. `J000712_BushyTailsLtd_AnnualCRP_2024_Commuting.xlsx`.
  Note this adds **JobName** (absent from the live convention) and uses the single **reporting year**.
- **Embedded identity block is the source of truth, not the filename:** a locked header block carries
  immutable **JobId**, JobNumber, ClientName, JobName, ReportingYear, ReportingPeriodStart/End, Domain,
  **TemplateVersion** and an integrity hash. **Preflight validates against the embedded JobId/period/
  version** and hard-blocks a wrong-job, wrong-period or stale-template file with a clear message —
  retiring the year-in-filename regex. (A renamed file can't fool it, because identity lives inside.)
- **Consistent headers across domains:** the same identifier block and the same reporting-period month
  columns (NZC-032) everywhere, with shared columns (Scope · Category/Report Label · ID · UOM · [months] ·
  Qty · Data Source · Notes) plus domain-specific columns (Company Vehicles: registration/type; Commuting:
  mode/distance-unit/WFH). The spend template (which carries PG&S) uses the same identity block — and is
  today's worst offender, currently hardcoded as `spend-data-template.xlsx`.

## 3. Part B — Client portal data entry

### 3.0 Portal information architecture

| Live portal areas (`PortalShell.tsx`) | Console portal (`PortalWorkspace.tsx`) |
|---|---|
| Dashboard, Portfolio, **Data Entry**, Metrics, Strategy, Risk, Governance, SRS Readiness, Reports, Insights, Files (11) | Results, **Data entry**, Documents, Messages (4) |

The Console portal is deliberately scoped to the M1 baseline (results + governed data entry + deliverables
+ messaging), and it does the *governance* of that baseline very well. The breadth gap (Portfolio, Metrics,
Strategy/actions, Risk, Governance, SRS, Insights) is M3/M4 work and mostly *read* surfaces — lower
priority for this data-entry review, but noted.

### 3.1 Data-entry capture — the core comparison

Live portal data entry has **three distinct capture modes plus vehicle lookup**; the Console has **one
generic record**.

| Client capture | Live | Console (`PortalEntryRecords.tsx`) | Status | Sev |
|---|---|---|---|---|
| Authorised buckets (categories the client may self-serve) | `portal/data-entry/buckets` + per-bucket factors | ✅ buckets with allowed units/sites/factors; access window + expiry | [PARITY]/[NEW] | — |
| Manual activity row | quantity + unit + factor + site + note, **+ monthly breakdown** | quantity + unit + factor + site + note (**no monthly**) | [PARTIAL] | **P0** |
| **Spend entry** (Net value, VAT %, GL/nominal code, category, **monthly**, AI categorisation) | `portal_spend_routes.py` (13 endpoints) + `PortalSpendTab.tsx` | ✗ (generic record only) | [GAP] | **P0** |
| **Commuting entry** (vehicle reg, mode, distance unit, WFH days, hours/day, **monthly**) | `portal_commuting_routes.py` + `PortalCommutingTab.tsx` | ✗ | [GAP] | **P0** |
| **Vehicle-registration lookup** | `POST /portal/vehicle-lookup` | ✗ | [GAP] | P1 |
| Spend/commuting **CSV/workbook upload + preview + commit** | `upload-preview`/`upload-commit` | ✗ | [GAP] | P1 |
| "Frequently used" / "Previously used" / "Copied from previous years" factor shortcuts | ✅ in all three tabs | ✗ | [GAP] | P1 |
| Draft → **submit → staff review queue** (never counts as reviewed) | ✅ | ✅ (submit routes into review; strong wording) | [PARITY]/[NEW] | — |
| Optimistic concurrency + stale-version recovery | partial | ✅ `expectedVersion`, 409 recovery | [NEW] | — |
| Data-entry expiry window + scheduled/open states | `portal-data-entry-expiry` | ✅ grant + window, "scheduled/open" states | [PARITY] | — |

**The key point.** The Console's mock bucket type already declares
`entryKind: "manual_activity" | "spend" | "commuting" | "vehicle"` (`PortalWorkspace.tsx`), and the
DEVELOPMENT_PLAN P3 explicitly intends to "cover manual activity, spend, commuting, and vehicle entry" —
but the current UI renders **the same quantity+unit+factor+site+note form for every kind**. So the
*intent* to differentiate is captured; the *capture richness* (VAT/GL for spend, vehicle reg/mode/WFH for
commuting, monthly for all) and the *automations* (AI categorisation, vehicle lookup, upload, used-before
shortcuts) are not implemented. This is the portal equivalent of §2.1's monthly/structure gaps and shares
the same schema decision.

### 3.2 The submission → register bridge

Live closes the loop with `PendingPortalSourceSubmissions` on the consultant's Data-Entry sections: client
submissions surface for the consultant to accept into the register. The Console **has an end-to-end loop**:
the client submits (`data-entry-records`), and a staff review queue
(`app/platform/PortalDataEntryReviewQueue.tsx` → `decidePortalDataEntryReview`) lets a consultant **accept**
(imports the submitted values as *pending, uncalculated* scope evidence, still requiring independent
emissions review) or **reject** with a reason, under optimistic concurrency. This governance is good and
ahead of live. **Status [PARTIAL], P1** for two reasons: (a) the queue lives in the **Platform** workspace,
not inside the CRP job the submission belongs to, so a consultant working a job can't see or action its
pending client data in context; and (b) acceptance imports a **generic quantity/unit/factor** value,
inheriting §3.1's monthly/kind limitations. Recommendation: surface the queue **inside the CRP workspace**
(filtered to that job) and preserve the entry kind + monthly detail through acceptance.

---

## 4. Part C — UI/UX: reducing noise & optimising workspaces

The live surfaces are powerful but noisy; the Console is clean but currently thin. The goal is to keep the
Console's calm, evidence-first shell **while** absorbing live's capability — by design, not by adding tabs.

### 4.1 Where the live noise comes from (and what to keep)

- **Eight sub-tabs for one activity** ("get data in") force consultants to context-switch between Data
  Entry / Commuting / Asset Register / Business Travel / Spend / Custom Dataset / Client Factors / Notes.
  Keep the *capabilities*, drop the *tab sprawl*.
- **A very wide always-on grid.** `JobDataEntry` shows a column manager, 12 monthly columns, confidence,
  factor, dataset, original ID, report label, storage mode, notes — everything, always. It's information-
  dense to the point of overwhelming. Keep monthly/columns, but behind progressive disclosure.
- **Three parallel portal data modes** (buckets/spend/commuting) each with their own tab and controls.
  Keep the distinct capture, unify the chrome.
- **Repetition of the same factor picker** in four+ places with slightly different behaviour. Unify.

### 4.2 Recommendations — carry the Console's strengths, absorb the breadth

1. **One register, faceted — not eight tabs.** Keep the single emissions-source register. Add a **source-
   type facet** (Manual · Spend · Commuting · Asset · Import) as a filter/segment, not separate pages.
   Each type is a *capture adapter* that writes canonical scope rows; the register is the one truth.
   (Directly serves "optimise workspaces / reduce noise".)
2. **Edit in the evidence drawer (already the pattern) — extend it.** The drawer already edits a row and
   shows lineage/provenance. Add there: the **override + reason**, **per-row notes**, an **inline monthly
   expander** (12 slots, collapsed by default with a "12/12 · 3 empty" chip like live's completeness
   indicator), and **row activity history**. This keeps the table calm and puts depth one click away —
   the signature interaction, extended.
3. **Exception-first register.** Default the table to a **"needs attention"** view (no factor, no
   activity, calculation missing, review pending, YoY anomaly), with the full list one toggle away. The
   command centre already computes these counts — make each count a **click-through filter** into the
   register (today `nextAction` is text only).
4. **Bulk actions.** Multi-select rows for **bulk review**, **bulk repoint** (change factor for many),
   **consolidate**, enable/disable. This is the biggest single throughput win for consultants and closes
   §2.3 gaps at once.
5. **Column manager as saved views.** Replace live's per-session column toggling with a few **named saved
   views** (Entry, Review, Report-label QA), URL-persisted (ARCHITECTURE §8 already calls for URL-persisted
   filters). Fewer controls on screen, same power.
6. **One shared factor picker** component (`@nzi/ui`) with search, scope filter, top/frequently-used, and
   provenance preview — reused by CRP rows, spend mapping, commuting, and the portal. One behaviour,
   learned once.
7. **Portal: one data-entry surface, typed adapters.** Mirror #1 on the client side — a single "Provide
   data" screen with the bucket's `entryKind` choosing the field set (spend shows VAT/GL; commuting shows
   vehicle/mode/WFH; all show the monthly expander). Keep "frequently/previously used" chips to cut typing.
8. **Progressive completeness cues, not walls of red.** Reuse the readiness ring / gate pattern for
   *data completeness* per scope and per site, so the consultant (and client) see "what's left" without a
   dense status grid.
9. **Accessibility carries over as a gate** (ARCHITECTURE §8; DEVELOPMENT_PLAN P5): keyboard operation of
   the register + drawer, labelled inputs, status announcements — the portal already sets this bar; hold
   the CRP workspace to it as breadth is added.

### 4.3 Confirmed direction — the stage-as-section design language (NZC-038)

The redesign above is **confirmed and now the site-wide design language (NZC-038)**, proven in two interactive prototypes on J000712 data (consultant CRP workspace + client portal). The workspace *is* the progress bar: **the workflow stage drives the screen**, and each stage is its own section that

- is **named in user terms** matching the progress bar (e.g. *Data Entry*, not “Canonical evidence register”);
- carries its **stage number, a tick when complete, and the stage’s colour**, mirroring its node in the bar;
- **expands and collapses** to control noise, showing a one-line summary when collapsed;
- **sinks to a “Completed — for occasional reference” zone at the bottom** once done — job setup and configuration especially, since they are consulted infrequently.

A single slim status strip replaces the hero/ring/metric stack; detail opens in the evidence drawer on selection; working tables default exception-first. The **client portal is a constrained mirror** of the same language (NZC-016/035), not a separate visual system. This supersedes the live platform's ad-hoc “every card open, scroll past six sections to reach the data” layout. Applies to CRP, every other job family, the admin workspaces and the portal.

---

## 5. Part D — Automation & AI opportunities

All grounded, advisory, and consultant/client-confirmed (NZC-018: AI never the source of truth). Ordered by
value-to-effort.

| # | Automation | Grounding | Where it helps | Notes |
|---|---|---|---|---|
| 1 | **Spend → category → factor suggestion** (single + bulk), with confirm | live `suggest-categories-bulk` + factor library; retrieval over the client's own prior mappings + dataset factors | Removes the biggest manual burden in Scope 3 | Carry forward live behaviour but *ground it*: suggest from real factors, show confidence + evidence, consultant confirms; never auto-map |
| 2 | **Previous-year rollforward** (rows + spend mappings + commuting structure) | last year's reviewed snapshot for the same client | Makes renewals near-instant | Deterministic, not AI; flag changed factor versions for re-review (ties to NZC-030 "rows stay on their version until explicit recalc") |
| 3 | **Vehicle registration → vehicle → factor** | live `vehicle-lookup` + `services/vehicle_lookup.py` | Commuting & fleet capture, portal and CRP | Deterministic lookup; a real speed-up for clients |
| 4 | **Bulk upload — Excel + paste grid + CSV mapper** (NZC-036) | live `excel-import-preflight`; embedded job identity; remembered per-client column mapping | Bulk entry without hand-keying, across all bulk domains (incl. spend/PG&S) | Preflight validates against the embedded JobId/period/version (five states), never the filename; paste grid = no round-trip |
| 5 | **Duplicate & anomaly detection** | rows within a job + YoY vs prior snapshot | Catch double-counting and fat-finger errors | Live already flags duplicate keys; add **YoY variance** and **unit-sanity** (e.g. kWh entered as MWh) as advisory flags in the exception view |
| 6 | **Factor-staleness / cross-country guard at entry** | dataset version + job country (NZC-011) | Stops a UK factor on a US job, or an out-of-period factor | Live has cross-country audit at admin level; surface it **at the point of factor choice** as a warning |
| 7 | **"Frequently/previously used" factor & category chips** | this client's history | Cuts typing for consultants and clients | Live has it in the portal; generalise to the shared factor picker |
| 8 | **Monthly auto-distribution** | annual figure + a profile (flat, HDD-weighted for heating, headcount for commuting) | When only an annual number exists | Advisory: propose a monthly split the consultant can accept/adjust; keeps the monthly model populated |
| 9 | **Completeness nudges tied to the data-entry expiry window** | grant window + missing buckets | Chase client data before the window closes | The window state already exists; add reminder scheduling + a per-bucket "what's outstanding" summary |
| 10 | **Draft evidence notes / report narrative** | reviewed rows + targets | Speeds report drafting | Out of scope for *entry* but adjacent; live has `report_drafting`; keep advisory |

**Guardrails (state once, apply to all):** every suggestion shows its source and confidence; a human
confirms before it changes a number; the result is written as a normal scope row/mapping carrying its
quality tier and provenance; AI output is never a second write path and never a factor of record.

---

## 6. Part E — Prioritised gap register

**P0 — parity-critical (resolve within M2/M3 and the portal capture work):**

1. Monthly (12-month) activity granularity on the scope row and portal entry — **schema decision** (§2.1, §3.1).
2. Scope-row reporting hierarchy (`level_1..4`) + explicit `report_label` — **schema decision** (§2.1).
3. Override tCO₂e + mandatory reason exposed in the drawer write path (§2.1).
4. Spend-based Scope 3 ingestion workflow (upload → map → AI suggest → sync-to-scope) (§2.2).
5. Client/custom factors (client-specific factor + supporting file) (§2.2).
6. Previous-year reuse / rollforward for renewals (§2.2).
7. Employee commuting capture (direct-by-vehicle + monthly + scale-to-headcount) (§2.2, §3.1).
8. Portal spend & commuting capture (VAT/GL; vehicle reg/mode/WFH) — currently one generic record (§3.1).
9. Structured scope selector replacing the free-text `scope` string (§2.1).

**P1 — important:**

11. Bulk review / bulk repoint / consolidate (§2.3).
12. Pending-review queue view + click-through from command-centre counts (§2.3, §4.2).
13. Asset/source register with grouping & roll-up (§2.2).
14. Business-travel workbook (download → prior-year compare → import) (§2.2).
15. Per-row notes + job notes with filters (§2.1, §2.3).
16. Per-entity activity history UI over existing audit events (§2.3).
17. Excel/CSV round-trip with preflight (§2.2, §5.4).
18. Explicit scope-config (include scopes + factor method) (§2.4).
19. Vehicle-registration lookup (CRP + portal) (§5.3).
20. Data confidence axis reconciled with quality tier (§2.1).
21. Surface the portal-submission review queue **inside the CRP workspace** (it exists in Platform) and preserve entry-kind + monthly detail through acceptance (§3.2).

**P2 — quality-of-life:**

22. Custom (job-specific) dataset construction (§2.2).
23. Storage mode / storage factor unit-conversion memory (§2.1).
24. Auto-derive intensity denominator from client facts (§2.4).
25. "Frequently/previously used" chips generalised to CRP (§5.7).
26. Portal breadth areas (Portfolio, Metrics, Strategy, Risk, Governance, SRS, Insights) — M4 (§3.0).

---

## 7. Decisions — confirmed 28 Aug 2026

This review surfaced four decisions that touch the canonical schema. **All four are now confirmed by
Francis (28 Aug 2026) and recorded as NZC-032–035 in `DECISIONS.md`**, together with the two smaller
confirmations below. They are summarised here for context; the register is the source of truth.

- **NZC-032 — Monthly activity granularity.** Does the canonical scope row (and portal entry) store a
  **12-month vector** with an annual roll-up, or annual-only with optional monthly? *Recommendation:*
  optional monthly vector on the row, annual roll-up derived; drives seasonality charts, mid-year site
  changes, and portal monthly capture. Month slots **follow the reporting period** (not a fixed calendar
  year) and the live **copy-month-1-to-all** quick-fill is preserved. **Confirmed 28 Aug 2026 (NZC-032).**
- **NZC-033 — Scope-row reporting hierarchy & label.** Adopt a controlled **category path (level_1..4)** +
  explicit **`report_label`** on the canonical row (defaulted from factor, overridable), replacing the
  free-text `scope` string? *Recommendation:* yes — the report breakdown/charts need a deterministic
  category source. **Confirmed 28 Aug 2026 (NZC-033).**
- **NZC-034 — Override capture in the write path.** Confirm the drawer exposes **override tCO₂e + mandatory
  reason** (already in the read model and an architecture principle). *Recommendation:* yes — small change,
  closes an audit-trail gap. **Confirmed 28 Aug 2026 (NZC-034).**
- **NZC-035 — Per-kind portal capture vs one generic record.** Do spend/commuting/vehicle buckets get
  **kind-specific fields + automations** (VAT/GL, vehicle reg/mode/WFH, AI categorisation, lookup), or stay
  a single generic record? *Recommendation:* typed capture adapters over the one canonical model (mirrors
  §4.2 #1/#7) — explicitly **one framework, not two disparate input systems**: portal and CRP share the
  model, validation, provenance and review workflow. **Confirmed 28 Aug 2026 (NZC-035).**

**Smaller confirmations (28 Aug 2026, Francis):** (a) AI **spend categorisation on entry** is
**task/row-specific, grounded and advisory only** (NZC-018) — it suggests from real factors and the
client's own prior mappings, a human confirms, and the written row carries its provenance and quality
tier; (b) **previous-year rollforward re-pins the prior factor versions** to keep year-on-year reporting
consistent and comparable (NZC-030), with any move to a newer version an explicit, audited recalculation.

---

## 8. Recommended next increments

Sequenced to preserve the governance spine and unblock the schema decisions first.

1. **Settle the schema decisions (NZC-032–035).** One short review with Francis; everything below depends
   on the monthly + hierarchy + override + portal-kind shape.
2. **Extend the canonical row + drawer** (M2 hardening): category path + report label, monthly vector
   (inline expander), override + reason, per-row notes, structured scope selector. No new pages.
3. **Ingestion adapters onto the one register** (M3): spend (with grounded AI categorisation + sync-to-
   scope), commuting (by-vehicle + monthly + scale), Excel/CSV preflight import, previous-year rollforward,
   client/custom factors. Each writes canonical rows; the register stays the single truth.
4. **Register throughput** (M3): exception-first default, click-through from command-centre counts, bulk
   review/repoint/consolidate, pending-review queue, duplicate/anomaly advisory flags, per-row activity
   history, shared factor picker.
5. **Portal capture parity** (portal track): typed adapters (spend/commuting/vehicle) with monthly and
   used-before chips; vehicle-reg lookup; **surface the existing portal-submission review queue inside the
   CRP workspace** (filtered to the job) and preserve entry-kind + monthly detail through acceptance.
6. **Asset/source register + business-travel workbook** (M3, P1) and the remaining P2 items as capacity
   allows.

Keep every increment inside the current shell (AppShell · WorkspaceRail · TopBar · EvidenceDrawer), on the
one canonical scope-row model, with provenance and the five UI states — i.e. *breadth without losing the
calm*.

---

## 9. Appendix — evidence (files & endpoints)

**Live CRP data entry.** `nzi-live-fix/frontend/src/app/jobs/[jobId]/data-entry/[section]/page.tsx`
(8 sections); components `JobDataEntry.tsx`, `JobSourceRegister.tsx`, `EmployeeCommutingData.tsx`,
`SpendDataCollection.tsx`, `JobCustomFactors.tsx`, `JobCustomDataset.tsx`, `JobNotesSummary.tsx`,
`PendingPortalSourceSubmissions.tsx`, `ActivityHistoryModal.tsx`. Backend: `api/job_scope_data_routes.py`
(scope rows, review, repoint, consolidate, pending-review), `api/job_setup_routes.py` (scope-config +
Excel round-trip), `api/spend_data_routes.py`, `api/employee_commuting_routes.py`,
`api/job_custom_factors_routes.py`, `api/custom_factors_routes.py`, `api/job_intensity_routes.py`.

**Live client portal.** `nzi-live-fix/portal/src/components/PortalShell.tsx` (11-area nav),
`PortalDataEntry.tsx`, `PortalSpendTab.tsx`, `PortalCommutingTab.tsx`. Backend:
`api/portal_data_entry_routes.py`, `api/portal_spend_routes.py`, `api/portal_commuting_routes.py`,
`api/portal_vehicle_routes.py`, plus `api/portal_routes.py`.

**Console CRP.** `apps/console/app/jobs/CrpScopeWorkspace.tsx`; contracts
`packages/contracts/src/commands.ts` (`ScopeRowWriteFields`/`ScopeRowReadModel`, command list); routes under
`apps/console/app/api/isolated/jobs/[jobId]/...` (scope-rows, calculate, review, datasets/manual,
emissions-target, intensity-target, sites, purchased-goods-categories, reviewed-snapshots).

**Console portal.** `apps/console/app/portal-preview/PortalWorkspace.tsx`,
`apps/console/app/portal/PortalEntryRecords.tsx`; routes
`apps/console/app/api/portal/jobs/[jobId]/data-entry-records/route.ts`, `.../data-entry-access/route.ts`;
mock `packages/mock-data/src/portal.ts`; queue stub `apps/console/app/platform/PortalDataEntryReviewQueue.tsx`.

**Design references.** `docs/WORKFLOWS.md` (§4 scope rows, §4.3 ingestion, §7–8 portal), `docs/ARCHITECTURE.md`
(§4.4 scope row, §5 evidence, §6 families), `docs/DECISIONS.md` (NZC-005, 008, 010, 011, 018, 030),
`docs/DEVELOPMENT_PLAN.md` (M1 portal P3 data entry, M2 CRP).

*Prepared 28 Aug 2026. This is Part 1 (data entry). Suggested follow-ups: reporting/graphics pipeline
parity, commercial/CRM, and the LCA/Training family data models.*
