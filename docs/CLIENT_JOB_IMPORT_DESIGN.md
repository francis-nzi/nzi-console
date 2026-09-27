# NZI Console — Importing v7 clients and jobs, with their history

**What this is.** The characterisation and proposed design for bringing NZ Insights Pro v7's active clients and
their full job history — historical emissions and published reports included — into `net-zero-international`.
**For ruling. Nothing is exported, moved or built yet.**

**Status (27 Sep 2026).** Characterised from code and schema only (§1). Volumes are not yet known: they need the
read-only counts in Appendix A run against live v7 (§9). Numbered decisions for ruling are collected in §11.

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
  was stopped; its output was never read. Every later search was confined to code folders.)
- **Console:** migrations and backend source, as of `main` at `64df7ac`.
- **v7 has no single schema definition.** Tables come from a pg_dump baseline (`sql_migrations/0001_init.sql`)
  plus 0002–0074, from `core/migrations.py`, and from route modules that run `CREATE TABLE`/`ADD COLUMN IF NOT
  EXISTS` when first called. So the column lists below are what the code expects; **the authoritative column
  list is live `information_schema`**, captured by Appendix A before any build.
- **Undetermined from code** (Appendix A settles each): whether `jobs.assigned_user_id` and `clients.created_at`
  exist; the distinct values actually in use in the free-text `clients.status` and `jobs.status`; whether spend
  entries also materialise scope rows (a double-count risk); how far stored `calc_tco2e` differs from v7's
  recomputed totals.

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
  which are synthetic — they would be renumbered or retired first. **Recommended.**
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
- **Deactivate-not-delete** still applies: `enabled` is carried from v7 as is. Whether a person may later
  **disable** a migrated row (the one mutation that doesn't alter the figure) is decision 4.

**Why one table and not a separate `migrated_scope_rows`:** every read path — totals, trajectory, portal
dashboards, intensity — reads `job_scope_rows`. One table means historical years appear everywhere without
touching those paths; the risk moves to the write paths, which the trigger and the command guards close. A
separate table would need every reader changed, and a missed reader would silently show a history with nothing
in it.

**Which figure is "as v7 recorded" — decision 2.** v7's row figure and the figure v7 showed a client can
differ (§2.3). Proposed:

- **The published report is the authoritative historical total** for any job that has one. It is what the
  client received.
- Row-level migrated figures are the **evidence behind it**, imported as v7 stored them.
- The load **reconciles**, per job, the sum of migrated row figures against the published snapshot's totals, per
  scope. A difference is **reported, never corrected**, and the console shows both, labelled.
- For a job with **no published report**, the migrated row sum is the historical figure, marked as unpublished.

### 5.2 Reports

**Proposed: a separate, append-only `legacy_report_versions` table**, not the console's snapshot → version →
composition chain, which v7's reports cannot honestly pass (§3). Proposed columns:

- keys: `organisation_id`, `report_id`, `job_id`, `source_system`, `legacy_db_id`;
- `version_number`, `status` (v7's, verbatim), `report_format`;
- **`snapshot_json` verbatim**, plus v7's `data_hash`, **verified on import** (SHA-256 recomputed; a mismatch
  refuses that report);
- `published_at` / `published_by`, and `is_portal_version` (from `report_reviews.portal_version_id`);
- `pdf_sha256` and an asset reference (§5.3).

INSERT and SELECT only. A **read-only historical report view** renders it — a later build — for the console and
for the portal's history. It is never re-composed through the console's report engine.

### 5.3 PDFs — decision 3

The published PDFs are **files** on v7's server disk or in OneDrive, not in the database. Options:

- **(a) Import the published PDFs** as content-addressed assets (sha256, verified against the file), from a file
  export Francis makes alongside the SQL export. **Recommended for final/published versions only.**
- **(b) Snapshot JSON only;** PDFs left in v7/OneDrive with the link kept as provenance.

## 6. Scope rules

- **Clients:** active by the §2.1 predicate. Archived clients are not imported (ruled scope).
- **Jobs:** every job of an imported client, whatever its status — full history. A job with no client (v7
  permits it for training) is outside a client's history: excluded and reported.
- **Status mappings** (decision 5, finalised once Appendix A returns the values in use):
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

## 7. PII — everything personal, sealed on write

Client personal data now enters the isolated store, so sealing is mandatory, in the same transaction as the write.

| v7 source | Console destination | Sealing |
|---|---|---|
| `client_contacts`: `full_name`, `job_title`, `email`, `phone` | `client_contacts` | `sealClientContactRow` |
| `crp_job_details`: `client_contact_name/email`, `report_signee_name/position` | contact links / report signee fields | existing sealed signee and contact columns (0100) |
| `report_reviews`: `approved_by_name/email` | `legacy_report_versions` | a sealed column on the new table |
| `job_emission_sources.employee_name` | register source detail | sealed (a new sealed column) |
| `clients.crm_owner` / `client_manager` | owner (matched) or `owner_name` | existing sealed column |
| **`job_report_versions.snapshot_json`** — contains signee names and other personal detail | `legacy_report_versions` | **decision 6** |

**Decision 6 — PII inside verbatim report snapshots.** Verbatim storage and field-level sealing conflict: the
JSON cannot be edited to seal a name without ceasing to be verbatim. Options:

- **(a) Seal the whole payload** under the client's subject key: stored as ciphertext, decrypted only to render,
  covered by a key-shred at erasure. The hash is verified before sealing and kept. **Recommended.**
- **(b)** Store it plaintext, and record it in the PII inventory as unsealed.

## 8. The process

1. **Extract — Francis, read-only.** A SQL export of the in-scope rows (Appendix B lists the tables), plus the
   published PDFs if decision 3 is (a), onto his machine. **Never committed** (NZC-020). The run records the
   extract's SHA-256.
2. **Plan — pure, like `v7ReferenceImport`.** Extract in, validated plan out, with the three kinds of finding:
   - **refusals** block the load (a hash mismatch, a job-number clash, an orphaned FK, an unknown status);
   - **exclusions** are a closed, named list (e.g. a client-less training job, an archived client's row);
   - **reports** are shown and the load goes ahead (unmatched owners or lookups, reconciliation differences).
3. **Load — boundary-guarded, from the Render Shell, a dry run unless `--commit`.** In FK order: clients → sites →
   contacts → targets/baseline → jobs (+ config) → scope rows / register → report versions (+ PDFs). One
   transaction per client, so a failure leaves whole clients or nothing.
4. **Idempotent, reconcile-by-reading.** Each row is matched on `(org, source_system, legacy_db_id)`. Absent →
   insert; present and identical → no-op; **present and different → refused**, because history is immutable and
   a changed v7 row means v7 changed after migration — for a person to look at. Nothing is deleted: a v7 row
   missing from a later extract is reported, not removed.
5. **Separation of duties, audit, review — decision 7.** The console's review and approval gates exist for *new*
   work. Migrated rows arrive as v7 left them: review status carried from v7, never re-approved in the console,
   and the import is audited as one act by the operator. That is a **ruled exemption for migrated history**, and
   it is only safe because §5.1's immutability makes the rows unchangeable afterwards.

## 9. Volumes — not yet known

The load, the PII surface and the report surface cannot be sized from code. **Appendix A** is read-only SQL for
Francis to run against live v7. It returns **counts and enumerated status values only — no names, no free text**.
The figures come back into §9 before any build is ruled:

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

1. Provenance columns (`source_system`, `legacy_db_id`, and the verbatim identifiers) and their partial unique
   keys on `clients`, `client_sites`, `client_contacts`, `jobs`, `job_scope_rows`, `job_emission_groups`,
   `job_emission_sources`.
2. `job_scope_rows.origin` + `migrated_record`, their CHECKs, and the **immutability trigger**.
3. `legacy_report_versions`, append-only, with its sealed payload and approver columns.
4. The PII inventory entries for every new personal-data column.
5. If decision 1 is (a): moving the job-number counter past the imported maximum, under the same definer function.

## 11. Decisions for ruling

1. **Job numbers:** keep v7's (recommended) or new ones with v7's shown beside them.
2. **Authoritative historical total:** the published report where one exists, rows as evidence, differences
   reported (recommended).
3. **PDFs:** import the published ones as verified assets (recommended), or leave them in v7/OneDrive.
4. **May a migrated row be disabled later?** (Recommended: yes, audited, with a reason — the figure itself never
   changes.)
5. **Status mappings,** once Appendix A shows the values in use.
6. **PII in report snapshots:** seal the whole payload (recommended), or record it as unsealed.
7. **The exemption from review and separation of duties for migrated history** (§8.5).
8. **"Active client"** as `status = 'Active'` and not archived.

## 12. Build sequence, once ruled

1. Migrations (§10), ruled.
2. Extract, with Appendix A's figures filled into §9.
3. Transform and plan (pure, tested against a synthetic extract shaped like v7's).
4. Clients → sites → contacts → targets.
5. Jobs → emissions (migrated, immutable).
6. Reports (+ PDFs).
7. The historical report view, for console and portal.

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
                      'job_report_versions','report_reviews','job_files','job_custom_factors')
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
`lca_assessments` + `lca_result_snapshots`, `job_report_versions`, `report_reviews`, `job_custom_factors`, and the
lookups `industries_lookup`, `referrals_lookup`, `portfolios_lookup`, `job_statuses_lookup`, plus the
rows of v7's `datasets` table that the scope rows reference (for the year and version recorded in each migrated
figure). Exported as one file per table with a manifest of row counts and hashes. Kept off the repository.
