# NZI Console — Importing v7 clients and jobs, with their history

**What this is.** The characterisation and proposed design for bringing NZ Insights Pro v7's active clients and
their full job history — historical emissions and published reports included — into `net-zero-international`.
**Nothing is exported, moved or built yet.**

**Status (27 Sep 2026).** Characterised from code and schema only (§1). **The eight decisions in §11 are ruled**
(recorded there, against each). The build additions asked for at that ruling — the double-count guard, LCA
results, client custom factors — are §6.1–§6.3, with one new decision (9, the row figure) for ruling.

**Gate before any migration or build.** The migrations in §10 come for ruling only once (1) Francis has run
Appendix A and §9 is filled, and (2) Francis has recorded the data-protection decision for bringing client
personal data into the isolated store.

**Reading order:** `REFERENCE_DATA_DESIGN.md` (the governed shape this mirrors) → this document →
`WORKFLOWS.md` §3–§8 (how v7 is used).

**Ruled before this document (held to throughout).**

1. Source: a SQL export from live v7, read-only — never a write to live.
2. Scope: **active clients and their full job history**; deactivated sub-records import as deactivated.
3. Depth: **full** — historical emissions entries and published reports, not just record shells.
4. **Immutable history:** migrated emissions and reports are preserved exactly as v7 recorded them, never
   re-resolved through the console's resolver. The new resolver governs new capture only.
5. Client PII is sealed on write through the same helpers as staff (NZC-119).
6. Idempotent, reconcile-by-reading, deactivate-not-delete, boundary-guarded to isolated-non-production, no
   synthetic data. Load order clients → jobs → emissions/reports.

---

## 1. How this was characterised, and its limits

- **v7:** its codebase (`nzi_pro_v7-POSTGRES`), read for **code and schema only** — `sql_migrations/`,
  `core/`, `api/`, `services/`, `models/`, `scripts/`. None of v7's client-data folders was read, and nothing
  here names a person or a client. (One early recursive search began walking the whole folder tree before it
  was stopped; its output was never read.)
- **Standing rule (reaffirmed 27 Sep 2026):** every automated search, grep or glob over v7 is confined to its
  code folders, named explicitly. Its client-data folders (`clients/`, `job_data_uploads/`, `tmp_legacy_import_*`,
  `test_output/`, `legacy_archive/`, `assets/`, and any data file) are off-limits even to a pattern search.
- **Console:** migrations and backend source, as of `main` at `64df7ac`.
- **v7 has no single schema definition.** Tables come from a pg_dump baseline (`sql_migrations/0001_init.sql`)
  plus 0002–0074, from `core/migrations.py`, and from route modules that run `CREATE TABLE`/`ADD COLUMN IF NOT
  EXISTS` when first called. So the column lists below are what the code expects; **the authoritative column
  list is live `information_schema`**, captured by Appendix A before any build.
- **Undetermined from code** (Appendix A settles each): whether `jobs.assigned_user_id` and `clients.created_at`
  exist; the distinct values actually in use in the free-text `clients.status` and `jobs.status`; how far stored
  `calc_tco2e` differs from v7's recomputed totals. (Whether spend entries materialise scope rows is now settled
  from code — they do, §6.1.)

## 2. v7's source of record

### 2.1 Clients

| v7 | What it holds | Notes |
|---|---|---|
| `clients` (PK `db_id` int) | name, company reg, SIC, industry (text), website, HQ, address, year-end, currency, billing address, logo | `core/migrations.py:17` |
| | `crm_owner`, `client_manager` — **free-text names**, not user ids | `services/client_context_columns.py:21` |
| | `portfolio`, `referral` — **text**, matched to `industries_lookup` / `referrals_lookup` / `portfolios_lookup` **by name** | `api/admin_routes.py:1113,1408` |
| | targets and baseline on the row: `net_zero_year`, `interim_year`, `interim_s1..3_pct`, `target_s1..3_year/pct`, `benchmark_year`, `benchmark_period_start/end`, `benchmark_scope_1..3_tco2e`, `benchmark_total_tco2e` | one mutable row, no history (`services/baseline_resolution.py`) |
| | `status` (free text, default `Active`), `archived`, `archived_at`, `archived_by` | code writes only `Active` / `Archived` |
| `client_sites` (PK `site_id`) | `site_name`, `location` (one text address), `is_registered_office`, `vacated_date`, lat/long | soft delete: `archived`, `vacated_date` |
| `client_contacts` (PK `contact_id`) | **PII:** `full_name`, `job_title`, `email`, `phone`; `is_primary` | no soft-delete flag |

**"Active client"** is defined three ways across v7's screens. Proposed:
`COALESCE(status,'Active') = 'Active' AND NOT COALESCE(archived, false)`.

### 2.2 Jobs

| v7 | What it holds | Notes |
|---|---|---|
| `jobs` (PK `job_id` int) | `client_db_id` (nullable — training jobs may have none), `job_type_id`/`job_type`, `job_family` (`crp·consultancy·training·lca·pcf`), `job_number` (unique; `J` + 6 digits), `legacy_job_no` (WFM), `reporting_year`, `reporting_period_start/end`, `is_benchmark`, `start_date`, `due_date`, `status` (free text, default `Open`), `crm_name` (free-text owner), `quote_id`, `created_at` (no `updated_at`), `archived*`, `portal_visible`, report metadata (`baseline_year`, target years, `glossary_terms`, `intensity_metrics`) | `core/migrations.py:608`, `781`; job numbers are max+1, and some paths use `job_id+999` |
| `crp_job_details` (1:1) | `reporting_period_from/to`, `reporting_year`, renewal flag, order number, **PII:** `client_contact_name/email`, `report_signee_name/position` | `core/migrations.py:1043` |
| status lookup | Open, Data Gathering Phase, Reporting Phase, Awaiting Client Input, Completed, Closed | the PATCH endpoint accepts any value |

### 2.3 Captured emissions

| v7 | What it holds |
|---|---|
| `job_scope_rows` (PK `row_id`) | `job_id`, `site_id`; `scope`, `category`, `level_1..4`, `column_text`, `report_label`; `qty`, `uom`, `month_1..12`, `apply_pct`, `source_qty/uom`; **factor copied onto the row:** `dataset_id`, `factor_db_id`, `original_id`, `factor`, `ghg_unit`; `calc_tco2e`, `override_tco2e`, `override_reason`; `data_source`, `data_confidence`, `is_custom_entry`; T&D pairing (`linked_row_id`, `is_auto_generated`, `auto_pair_kind`); `review_status`; `submitted_by_portal`; soft delete `enabled = false` |
| `job_emission_groups` / `job_emission_sources` | the asset/vehicle/commuting/spend register; sources store `qty`, `factor`, `ghg_unit`, `calc_tco2e`, `month_1..12`, `detail_json`, **PII:** `employee_name` |
| `job_spend_entries` | spend lines with `estimated_emissions_tco2e`, `is_deleted` |
| `lca_assessments`, `lca_result_snapshots` | LCA/PCF results (JSONB snapshots) |
| `crp_scope_entries` | an older entry model, read-only paths only |
| `job_custom_factors`, `custom_factors`, `custom_factor_year_values` | client-specific factors |

**The finding that matters most: v7 does not treat a scope row's stored figure as the record.** Its reporting
query selects `NULL::numeric AS calc_tco2e` for scope rows (`services/emissions_reporting.py:211`) and recomputes
`qty × factor × apply_pct` on read (`services/monthly_emissions.py:58-65`) — and, for monthly rows whose month
falls in a different dataset, **re-looks-up the factor from current tables** (`:627-691`). So a v7 total can
drift after the fact. The stored row figure (`override_tco2e ?? calc_tco2e`) and the figure a client was shown
can differ. What the client was shown is frozen in the report snapshot (§2.4).

There is **no market-based/location-based or supply-source field per entry** in v7 (computed only for report
variables).

### 2.4 Published reports

| v7 | What it holds |
|---|---|
| `job_report_versions` (PK `report_version_id`) | `job_id`, `client_db_id`, `version_number` (unique per job), `status` (`draft·review·final·superseded·archived`), `report_format` (`pdf·react`), **`snapshot_json`** (the full live-report payload, frozen at creation), **`data_hash`** (SHA-256 of it), the PDF as a **file** (`file_path`; `storage_provider` `local`/`onedrive` with `external_item_id/web_url/path`; `file_id` → `job_files`), generated/reviewed/finalized/superseded audit columns |
| `report_reviews` (one per job) | `status` (`draft·sent_for_review·changes_requested·approved`), `portal_version_id` (the frozen snapshot the client sees), `pdf_version_id`, `published_at`, `published_by`, **PII:** `approved_by_name/email` |
| `job_report_variable_values`, `job_report_drafts`, `job_emissions_certificates` | section text and certificates |

The v7 portal renders `snapshot_json`, never regenerating. **The PDFs are outside the database**: local disk or
OneDrive.

### 2.5 v7's own earlier import (for reference)

v7 imported WorkflowMax once (`wfm_import/wfm_import_routine.py`): an id map `wfm_import_map(entity_type,
wfm_id, nzi_id)`, an audit table, and **historical totals stored as synthetic scope rows** (`original_id =
'wfm-import-scope-N'`, `factor = 1`, `override_tco2e` set). A legacy annual workbook import similarly stored tCO₂e
as the quantity with `factor = 1`, provenance in the notes. Those rows exist in v7 and will come across — flagged
by their `data_source` (§6).

## 3. The console's target, and what it lacks

| Console | Fit |
|---|---|
| `clients`, `client_sites`, `client_contacts` (+ `client_contact_versions`), `client_targets` (append-only), `baseline_change_events` | Good fit. Contacts are sealed by `sealClientContactRow` (name, job title, phone; email with a blind index). |
| `jobs` (+ `job_emissions_config`, `job_dataset_selections`, `job_stage_history`) | Good fit. `job_family` values match v7's. `status` is `draft·open·on-hold·complete·cancelled`. |
| `job_scope_rows`, `job_emission_groups/sources` | Shape fits. **Behaviour does not:** `calculateScopeRow` resolves the factor live and rewrites `calculated_tco2e`, `provenance_json` and `lineage_json`; any update clears the figure and resets review. |
| `reviewed_crp_snapshots` → `report_versions` → `report_compositions` | **Does not fit v7's reports.** The console's snapshot payload is its own shape, hashed with its own rules, gated on every row approved, zero integrity gaps and separation of duties. v7's `snapshot_json` is a different payload, already published. |
| Provenance columns | Exist **only** on the three factor tables (0125–0126). None on clients, jobs, scope rows or reports. |
| Job numbering | One global counter (`job_number_counter`, `allocate_job_sequence()`); `sequence` is **globally** unique across organisations; `job_number = 'J' ‖ lpad(sequence, 6)`. |

## 4. Identity and provenance

Mirroring the reference import.

- **`source_system = 'nzi-pro-v7'`** and **`legacy_db_id`** (v7's primary key, as text) on every imported row, in
  every table below. Where v7 carries a human identifier, keep it verbatim beside it (`legacy_job_number`,
  `legacy_wfm_job_no`).
- **Identity key `(organisation_id, source_system, legacy_db_id)`**, a partial unique index where `source_system
  IS NOT NULL`, per table. A re-run lands on the same rows.
- **Console ids derived from v7 ids**, so they are stable and legible without the map: `v7-client-<db_id>`,
  `v7-site-<site_id>`, `v7-contact-<contact_id>`, `v7-job-<job_id>`, `v7-row-<row_id>`, `v7-report-<report_version_id>`.
- **Provenance required wherever `source_system` is set** (a CHECK, as 0126 does for factors).
- **Load audit:** one audit event per imported client and per job, naming the run, the extract's hash and the
  counts. Not one per row — the import is a single governed act, not thousands of commands.

**Job numbers — decision 1.** v7's official numbers (`J000612`…) are the ones NZI and its clients know. NZC-025
says numbering continues in that format from one allocator. The catch: `sequence` is globally unique, the
counter started at 0, and **staging's demo jobs already hold low sequences**. Options:

- **(a) Keep v7's numbers.** Write `sequence` = v7's number, refuse any clash, then set the counter to at least
  max(imported), so new jobs continue after v7. Clashes are only possible with the demo organisation's sequences,
  which are synthetic — they would be renumbered or retired first. **← Ruled: (a).** The counter moves past the
  imported maximum; only demo-organisation clashes are retired, nothing else is renumbered.
- **(b) New console numbers**, with v7's number kept as `legacy_job_number` and shown beside it. No clash; but a
  client's "J000612" would appear under a different official number.

## 5. Immutable history — how a migrated figure differs from a live one

### 5.1 Emissions rows

**Proposed: the same `job_scope_rows` table, a declared origin, and immutability in the database.**

- `origin text NOT NULL DEFAULT 'live' CHECK (origin IN ('live', 'migrated'))`.
- `migrated_record jsonb` — **required when migrated, forbidden when live** — v7's row exactly: `qty`, `uom`,
  monthly values, `apply_pct`, the factor as v7 copied it (`factor`, `ghg_unit`, `dataset_id` with that
  dataset's year/version, `factor_db_id`, `original_id`), `calc_tco2e`, `override_tco2e`/`override_reason`,
  `data_source`, `data_confidence`, `enabled`, `review_status`.
- The console's `calculated_tco2e` = v7's `override_tco2e ?? calc_tco2e`, stored once. `provenance_json` records
  that it is v7's figure, with v7's factor provenance; `lineage_json` shows v7's chain. `factor_id` and
  `dataset_id` are v7's own ids, carried as text; **they are never resolved against the console's factor
  tables** (the same id may exist there — irrelevant).
- **Immutable by construction, twice over:**
  - a **database trigger** refuses any UPDATE of a migrated row's measurement, factor, figure, provenance or
    origin columns, whoever writes;
  - `createScopeRow`, `updateScopeRow`, `calculateScopeRow`, the declarative resolver, rollforward and the
    re-point paths **refuse a migrated row** with a message naming why.
- **Deactivate-not-delete** still applies: `enabled` is carried from v7 as is. **Ruled (decision 4): a migrated
  row may be disabled — and nothing else** — through its own audited command with a reason. The trigger permits
  exactly that one column change (`enabled` true → false, and back); the figure never changes.

**Why one table and not a separate `migrated_scope_rows`:** every read path — totals, trajectory, portal
dashboards, intensity — reads `job_scope_rows`. One table means historical years appear everywhere without
touching those paths; the risk moves to the write paths, which the trigger and the command guards close. A
separate table would need every reader changed, and a missed reader would silently show a history with nothing
in it.

**Which figure is "as v7 recorded" — decision 2, ruled.** v7's row figure and the figure v7 showed a client can
differ (§2.3). **Ruled as proposed — the published report is authoritative; differences are reported, never
corrected:**

- **The published report is the authoritative historical total** for any job that has one. It is what the
  client received.
- Row-level migrated figures are the **evidence behind it**, imported as v7 stored them.
- The load **reconciles**, per job, the sum of migrated row figures against the published snapshot's totals, per
  scope. A difference is **reported, never corrected**, and the console shows both, labelled.
- For a job with **no published report**, the migrated row sum is the historical figure, marked as unpublished.

**The row figure itself — decision 9 (new, for ruling).** "As v7 recorded" is ambiguous at row level, because
v7 kept two figures that can disagree, and **v7's own code documents one of them as wrong**:

- the **stored** `calc_tco2e` (or `override_tco2e`). For every spend-pushed row it was, until fixed, **stored
  1000× too large** — v7's comment says so, and that the reported total was unaffected because reporting never
  reads the stored column (`api/spend_data_routes.py:2434-2445`);
- the **figure v7 reported**: `qty × factor × apply_pct / 100` (÷ 1000 when the factor is per kg), using the
  factor **copied onto the row** (`services/monthly_emissions.py:58-65`), with `override_tco2e` taking precedence.

Proposed: the migrated row's figure is **the one v7 reported** — v7's own arithmetic on v7's own recorded inputs,
not a re-resolution (no factor is looked up; the row's copied factor is used). `migrated_record` keeps **both**,
and a row where they differ beyond rounding is **reported**. One case v7's arithmetic cannot be replayed from the
row alone: a monthly row whose months fall in a different dataset, which v7 re-looks-up from its factor tables at
read time (`services/monthly_emissions.py:627-691`). Such rows keep the row-level figure, are flagged, and the
job's published report (authoritative, decision 2) is what stands for them.

### 5.2 Reports

**Proposed: a separate, append-only `legacy_report_versions` table**, not the console's snapshot → version →
composition chain, which v7's reports cannot honestly pass (§3). Proposed columns:

- keys: `organisation_id`, `report_id`, `job_id`, `source_system`, `legacy_db_id`;
- `version_number`, `status` (v7's, verbatim), `report_format`;
- **`snapshot_json` verbatim**, plus v7's `data_hash`, **verified on import** (SHA-256 recomputed; a mismatch
  refuses that report);
- `published_at` / `published_by`, and `is_portal_version` (from `report_reviews.portal_version_id`);
- the PDF's **storage link only** — `storage_provider`, `file_path` or OneDrive `external_item_id`/`web_url` —
  as provenance (§5.3).

INSERT and SELECT only. A **read-only historical report view** renders it — a later build — for the console and
for the portal's history. It is never re-composed through the console's report engine.

### 5.3 PDFs — decision 3, ruled: (b)

The published PDFs are **files** on v7's server disk or in OneDrive, not in the database. **Ruled: (b)** — this
migration imports each report's `snapshot_json`, its hash and its **storage link only**. **No PDF binary is
imported.** Bringing the published PDFs across as verified, content-addressed assets is a later, separately
ruled step.

## 6. Scope rules

- **Clients:** active by the §2.1 predicate — **ruled provisionally (decision 8)**, confirmed or amended once
  Appendix A shows the status values actually in use. Archived clients are not imported (ruled scope).
- **Jobs:** every job of an imported client, whatever its status — full history. A job with no client (v7
  permits it for training) is outside a client's history: excluded and reported.
- **Status mappings** (decision 5 — **ruled provisionally**; finalised once Appendix A returns the values in use):
  - clients: `Active` → `active`;
  - jobs: `Completed`/`Closed` → `complete`; `Open`, `Data Gathering Phase`, `Reporting Phase`, `Awaiting
    Client Input` → `open`, with v7's status kept verbatim as the job's `workflow_stage`; archived → `cancelled`.
- **Deactivated sub-records import as deactivated:** archived or vacated sites (`vacated_effective`), disabled
  rows (`enabled = false`), superseded/archived report versions (status verbatim), deleted spend entries (voided).
- **Rows v7 itself synthesised** (`data_source` `WFM Import` / `Legacy Annual Upload`, `factor = 1`) come across as
  migrated rows **labelled as such** — v7's recorded history, not measured activity.
- **Owners and managers** (`crm_owner`, `client_manager`, `crm_name` are free-text names): matched to memberships
  by name, reported when unmatched and kept as the existing sealed `owner_name` text — never guessed. The same
  pattern as the client-reference backfill.
- **Industry, referral, portfolio:** matched by name to reference values; unmatched values reported.
- **Not imported:** portal users and their credentials (re-invited through the console's own flow); CRM
  timeline, notes and touchpoints; quotes/invoices (out of scope — could follow).

### 6.1 The double-count guard

**Settled from v7's code: spend entries do materialise scope rows.** `sync_spend_to_scope_data`
(`api/spend_data_routes.py:2314-2625`) aggregates each job's mapped spend entries into scope rows marked
`data_source = 'Spend Data'`, one per (scope, factor `original_id`, site). And v7 counts four sources in two
different ways. Its reporting total (`services/emissions_reporting.py`) is:

| v7 record | Counted as a figure | Why |
|---|---|---|
| enabled `job_scope_rows` — including `'Spend Data'` rows and `'Employee Commuting (Consolidated)'` rows (`auto_pair_kind = 'employee_commuting'`) | **yes** | the rows |
| enabled `job_emission_sources` except `source_type = 'employee_commuting'` (asset, vehicle, business travel) | **yes**, unioned on read | these registers are consolidated on read, never written back (`api/job_scope_data_routes.py:1170-1182`) |
| `job_emission_sources` with `source_type = 'employee_commuting'` | **no** | already in the consolidated commuting rows (`services/employee_commuting_consolidation.py`) |
| `job_spend_entries` | **no** | already in the `'Spend Data'` rows |

**The guard is v7's own counting rule, applied in the plan:**

1. **Only figure-bearing records become migrated figures:** enabled scope rows, and enabled non-commuting register
   sources. Spend entries and commuting register sources are imported as **evidence** — linked to the row that
   carries their figure, never counted.
2. **Refused** (the plan cannot be loaded until resolved):
   - a scope row stored with a register's *consolidated-on-read* `data_source` (`Asset Register (Consolidated)`,
     `Business Travel Register (Consolidated)`) — v7 never writes these, so one in the table would be counted
     twice beside its sources;
   - a spend entry or commuting source that is marked as a figure anywhere in the plan.
3. **Reported** (loaded as v7 left it, flagged for a person):
   - an enabled `'Spend Data'` row and an enabled row from another source for the same (job, scope, `original_id`,
     site) — v7's own known double-count (it cites job 663 in `spend_data_routes.py:2380-2387`);
   - a job whose `'Spend Data'` rows do not sum to its mapped, non-deleted spend entries, or whose consolidated
     commuting rows do not sum to its commuting sources;
   - the per-job total by v7's rule, against the published report's (decision 2).

### 6.2 LCA and PCF results — migrated-immutable snapshots

v7 keeps LCA/PCF work in `lca_assessments` (`total_tco2e`, `review_status` `draft·in_review·verified·published`)
and freezes results in `lca_result_snapshots` (JSONB). **Proposed:** LCA/PCF jobs import as job records like any
other; each **verified or published** `lca_result_snapshot` imports **verbatim** into the same append-only legacy
table as reports (§5.2), as `kind = 'lca-result'` — sealed, hash-recorded, read-only, never re-run through the
console's LCA engine. The working assessment data (line items, transport legs, gap fills) is **not imported**:
the frozen result is the record, and it is noted on the job that the working detail stayed in v7.

### 6.3 Client custom factors — for future capture, separately

Historical rows are **self-contained**: each migrated row carries the factor v7 copied onto it, and never points
at a console factor or client factor. So custom factors are not needed for history. The question is only whether
a client's own factors should be **available for new capture** in the console.

**Proposed: yes, as a separate step after the history load, for client-level factors only.**

- v7's client-level custom factors (`custom_factors` + `custom_factor_year_values`) for active clients → the
  console's client-factor model (reusable across that client's jobs). Each is marked `source_system = 'nzi-pro-v7'`
  with `legacy_db_id`, at its **most recent year's value**, and **active only if it was used in the client's
  most recent job** — others imported inactive, for a person to switch on.
- **Job-level** custom factors (`job_custom_factors`) are **not** imported as client factors: they belong to one
  job's history, which the migrated rows already carry.
- The exact column mapping waits on Appendix A's schema capture: these tables are created on first use in v7, and
  their columns could not be fixed from code.

## 7. PII — everything personal, sealed on write

Client personal data now enters the isolated store, so sealing is mandatory, in the same transaction as the write.

| v7 source | Console destination | Sealing |
|---|---|---|
| `client_contacts`: `full_name`, `job_title`, `email`, `phone` | `client_contacts` | `sealClientContactRow` |
| `crp_job_details`: `client_contact_name/email`, `report_signee_name/position` | contact links / report signee fields | existing sealed signee and contact columns (0100) |
| `report_reviews`: `approved_by_name/email` | `legacy_report_versions` | a sealed column on the new table |
| `job_emission_sources.employee_name` | register source detail | sealed (a new sealed column) |
| `clients.crm_owner` / `client_manager` | owner (matched) or `owner_name` | existing sealed column |
| **`job_report_versions.snapshot_json`** and `lca_result_snapshots` — contain signee names and other personal detail | the legacy snapshot table | **the whole payload sealed (decision 6, ruled)** |

**Decision 6 — PII inside verbatim report snapshots.** Verbatim storage and field-level sealing conflict: the
JSON cannot be edited to seal a name without ceasing to be verbatim. Options:

- **(a) Seal the whole payload** under the client's subject key: stored as ciphertext, decrypted only to render,
  covered by a key-shred at erasure. The hash is verified before sealing and kept. **← Ruled: (a).**
- **(b)** Store it plaintext, and record it in the PII inventory as unsealed.

**Before any of this is loaded:** Francis records the data-protection decision for bringing client personal data
into the isolated store (the gate at the top of this document).

## 8. The process

1. **Extract — Francis, read-only.** A SQL export of the in-scope rows (Appendix B lists the tables) onto his
   machine — no PDF files (decision 3). **Never committed** (NZC-020). The run records the
   extract's SHA-256.
2. **Plan — pure, like `v7ReferenceImport`.** Extract in, validated plan out, with the three kinds of finding:
   - **refusals** block the load (a hash mismatch, a job-number clash, an orphaned FK, an unknown status);
   - **exclusions** are a closed, named list (e.g. a client-less training job, an archived client's row);
   - **reports** are shown and the load goes ahead (unmatched owners or lookups, reconciliation differences).
3. **Load — boundary-guarded, from the Render Shell, a dry run unless `--commit`.** In FK order: clients → sites →
   contacts → targets/baseline → jobs (+ config) → scope rows / register (with the §6.1 guard) → report versions
   and LCA result snapshots. Client custom factors follow as a separate step (§6.3). One
   transaction per client, so a failure leaves whole clients or nothing.
4. **Idempotent, reconcile-by-reading.** Each row is matched on `(org, source_system, legacy_db_id)`. Absent →
   insert; present and identical → no-op; **present and different → refused**, because history is immutable and
   a changed v7 row means v7 changed after migration — for a person to look at. Nothing is deleted: a v7 row
   missing from a later extract is reported, not removed.
5. **Separation of duties, audit, review — decision 7, ruled.** The console's review and approval gates exist for
   *new* work. Migrated rows arrive as v7 left them: review status carried from v7, never re-approved in the
   console, and the import is audited as one act by the operator. The exemption applies **only to rows whose
   `origin = 'migrated'`** — enforced in the gates themselves, not by convention — and is only safe because §5.1's
   immutability makes those rows unchangeable afterwards. Anything captured in the console afterwards, including
   on a migrated job, meets every gate as usual.

## 9. Volumes — not yet known

The load, the PII surface and the report surface cannot be sized from code. **Appendix A** is read-only SQL for
Francis to run against live v7. It returns **counts and enumerated status values only — no names, no free text**.
The figures come back into §9 before any build is ruled. **Pending — Appendix A not yet run.**

| Measure | Count |
|---|---|
| Active clients | — |
| Their jobs, by family and status | — |
| Scope rows (enabled / disabled) · of which v7-synthesised | — |
| Register sources · spend entries · LCA assessments | — |
| Report versions · final · published · portal versions · PDFs by storage provider | — |
| Contacts · sites (live / vacated or archived) | — |
| Job-number range of in-scope jobs · clashes with staging's sequences | — |

## 10. Migrations this will need (each through the ruling gate)

Held until §9 is filled and the data-protection decision is recorded.

1. Provenance columns (`source_system`, `legacy_db_id`, and the verbatim identifiers) and their partial unique
   keys on `clients`, `client_sites`, `client_contacts`, `jobs`, `job_scope_rows`, `job_emission_groups`,
   `job_emission_sources` — and on the client-factor table, for §6.3.
2. `job_scope_rows.origin` + `migrated_record` (holding both v7 figures, decision 9), their CHECKs, and the
   **immutability trigger**, which permits exactly one change on a migrated row: `enabled` (decision 4).
3. The legacy snapshot table (`legacy_report_versions`, with `kind` `report` | `lca-result`), append-only, with
   its sealed payload, approver columns and storage link — no PDF asset (decision 3).
4. The review and separation-of-duties gates exempting `origin = 'migrated'` rows, and only those (decision 7).
5. The PII inventory entries for every new personal-data column.
6. Moving the job-number counter past the imported maximum, under the same definer function (decision 1).

## 11. Decisions

Ruled 27 Sep 2026:

| # | Decision | Ruling |
|---|---|---|
| 1 | Job numbers | **(a) Keep v7's numbers**; the counter moves past the imported maximum; only demo-organisation clashes are retired. |
| 2 | Authoritative historical total | **The published report**; migrated rows are the evidence; differences reported, never corrected. |
| 3 | PDFs | **(b) `snapshot_json` + hash + storage link only.** No PDF binaries in this migration; importing them is a later, separately ruled step. |
| 4 | Disabling a migrated row | **Yes — disable only**, audited, with a reason. |
| 5 | Status mappings | **Provisional**; finalised with Appendix A. |
| 6 | PII in report snapshots | **(a) Seal the whole payload.** |
| 7 | Review / separation-of-duties exemption | **Limited to `origin = 'migrated'`.** |
| 8 | "Active client" predicate | **Provisional**; confirmed with Appendix A. |

For ruling:

| # | Decision | Proposed |
|---|---|---|
| 9 | A migrated row's figure (§5.1) | **The figure v7 reported** (v7's arithmetic on the row's own copied factor, override first), with the stored `calc_tco2e` kept beside it and any difference reported. |

And, from the ruling's build additions, proposed for confirmation: the double-count guard (§6.1), LCA results as
migrated-immutable snapshots (§6.2), client-level custom factors imported for future capture as a separate step
(§6.3).

## 12. Build sequence, once ruled

0. **Gate:** Appendix A run and §9 filled; the data-protection decision recorded.
1. Migrations (§10), ruled.
2. Extract.
3. Transform and plan (pure, tested against a synthetic extract shaped like v7's), including the §6.1 guard and
   the per-job reconciliation.
4. Clients → sites → contacts → targets.
5. Jobs → emissions (migrated, immutable).
6. Report versions and LCA result snapshots (verbatim, sealed; no PDFs).
7. Client custom factors, for future capture (§6.3).
8. The historical report view, for console and portal.

---

## Appendix A — read-only characterisation (for Francis to run on live v7)

Counts and enumerated values only. Some tables exist only once a feature has been used — check the first query.

```sql
-- 0. Which of the involved tables exist, and their columns (schema, not data)
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name IN ('clients','client_sites','client_contacts','jobs','crp_job_details','job_scope_rows',
                      'job_emission_groups','job_emission_sources','job_spend_entries','lca_assessments',
                      'job_report_versions','report_reviews','job_files','job_custom_factors',
                      'custom_factors','custom_factor_year_values','lca_result_snapshots','datasets')
 ORDER BY table_name, ordinal_position;

-- 1. The status values in use (enumerations, not free text)
SELECT 'clients' t, COALESCE(status,'∅') v, COALESCE(archived,false) a, count(*) FROM clients GROUP BY 1,2,3
UNION ALL
SELECT 'jobs', COALESCE(status,'∅'), COALESCE(archived,false), count(*) FROM jobs GROUP BY 1,2,3
ORDER BY 1,2,3;

-- 2. Active clients, and their jobs by family and status
WITH ac AS (SELECT db_id FROM clients WHERE COALESCE(status,'Active')='Active' AND NOT COALESCE(archived,false))
SELECT (SELECT count(*) FROM ac) AS active_clients;

WITH ac AS (SELECT db_id FROM clients WHERE COALESCE(status,'Active')='Active' AND NOT COALESCE(archived,false))
SELECT COALESCE(j.job_family,'∅') fam, COALESCE(j.status,'∅') st, COALESCE(j.archived,false) arch, count(*)
  FROM jobs j JOIN ac ON ac.db_id = j.client_db_id GROUP BY 1,2,3 ORDER BY 1,2,3;

-- 3. Entries and reports on those jobs
WITH aj AS (SELECT j.job_id FROM jobs j JOIN clients c ON c.db_id = j.client_db_id
             WHERE COALESCE(c.status,'Active')='Active' AND NOT COALESCE(c.archived,false))
SELECT
 (SELECT count(*) FROM job_scope_rows r JOIN aj USING (job_id) WHERE r.enabled)                          AS rows_enabled,
 (SELECT count(*) FROM job_scope_rows r JOIN aj USING (job_id) WHERE NOT r.enabled)                      AS rows_disabled,
 (SELECT count(*) FROM job_scope_rows r JOIN aj USING (job_id)
   WHERE r.data_source IN ('WFM Import','Legacy Annual Upload'))                                          AS rows_v7_synthesised,
 (SELECT count(*) FROM job_emission_sources s JOIN aj USING (job_id))                                   AS register_sources,
 (SELECT count(*) FROM job_spend_entries e JOIN aj USING (job_id))                                      AS spend_entries,
 (SELECT count(*) FROM lca_assessments a JOIN aj USING (job_id))                                        AS lca_assessments,
 (SELECT count(*) FROM job_report_versions v JOIN aj USING (job_id))                                    AS report_versions,
 (SELECT count(*) FROM job_report_versions v JOIN aj USING (job_id) WHERE lower(v.status)='final')      AS final_versions,
 (SELECT count(*) FROM report_reviews rr JOIN aj USING (job_id) WHERE rr.published_at IS NOT NULL)      AS published,
 (SELECT count(*) FROM report_reviews rr JOIN aj USING (job_id) WHERE rr.portal_version_id IS NOT NULL) AS portal_versions;

-- 4. Where the PDFs are
WITH aj AS (SELECT j.job_id FROM jobs j JOIN clients c ON c.db_id = j.client_db_id
             WHERE COALESCE(c.status,'Active')='Active' AND NOT COALESCE(c.archived,false))
SELECT COALESCE(v.storage_provider,'∅') provider, (v.file_path IS NOT NULL) has_path, count(*)
  FROM job_report_versions v JOIN aj USING (job_id) GROUP BY 1,2;

-- 5. Contacts and sites on active clients
WITH ac AS (SELECT db_id FROM clients WHERE COALESCE(status,'Active')='Active' AND NOT COALESCE(archived,false))
SELECT
 (SELECT count(*) FROM client_contacts k JOIN ac ON ac.db_id = k.client_db_id) AS contacts,
 (SELECT count(*) FROM client_sites s JOIN ac ON ac.db_id = s.client_db_id
   WHERE NOT COALESCE(s.archived,false) AND s.vacated_date IS NULL)             AS live_sites,
 (SELECT count(*) FROM client_sites s JOIN ac ON ac.db_id = s.client_db_id
   WHERE COALESCE(s.archived,false) OR s.vacated_date IS NOT NULL)              AS closed_sites;

-- 6. Job-number range of in-scope jobs (against which staging's sequences are checked)
WITH aj AS (SELECT j.job_number FROM jobs j JOIN clients c ON c.db_id = j.client_db_id
             WHERE COALESCE(c.status,'Active')='Active' AND NOT COALESCE(c.archived,false))
SELECT min(job_number), max(job_number), count(*),
       count(*) FILTER (WHERE job_number !~ '^J[0-9]{6}$') AS non_standard
  FROM aj;

-- 7. Stored row figures against v7's recomputed ones (the drift in §2.3), for published jobs only
--    — a count of rows where the stored calc differs from qty × factor × apply_pct by more than 0.1%.
WITH aj AS (SELECT j.job_id FROM jobs j JOIN clients c ON c.db_id = j.client_db_id
             WHERE COALESCE(c.status,'Active')='Active' AND NOT COALESCE(c.archived,false))
SELECT count(*) AS rows_checked,
       count(*) FILTER (WHERE r.calc_tco2e IS NOT NULL AND abs(r.calc_tco2e - r.qty * r.factor * COALESCE(r.apply_pct,100) / 100
         / CASE WHEN lower(r.ghg_unit) LIKE 'kg%' THEN 1000 ELSE 1 END) > 0.001 * greatest(abs(r.calc_tco2e), 1e-9)) AS rows_drifted
  FROM job_scope_rows r JOIN aj USING (job_id) WHERE r.enabled;
```

## Appendix B — the extract (for the build stop)

The tables, filtered to active clients and their jobs: `clients`, `client_sites`, `client_contacts`, `jobs`,
`crp_job_details`, `job_scope_rows`, `job_emission_groups`, `job_emission_sources`, `job_spend_entries`,
`lca_assessments` + `lca_result_snapshots`, `job_report_versions`, `report_reviews`, `job_custom_factors`,
`custom_factors` + `custom_factor_year_values` (§6.3), and the
lookups `industries_lookup`, `referrals_lookup`, `portfolios_lookup`, `job_statuses_lookup`, plus the
rows of v7's `datasets` table that the scope rows reference (for the year and version recorded in each migrated
figure). Exported as one file per table with a manifest of row counts and hashes. Kept off the repository.
