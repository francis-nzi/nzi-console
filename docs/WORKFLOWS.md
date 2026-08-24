# NZI Pro — Live CRM Workflow Deep-Dive

**Purpose.** This document is a ground-truth map of how the live NZI Pro platform
(`nzi_pro_v7-POSTGRES`, held locally under `NZI Live/`) actually works today. It exists so the
**NZI Console** redesign can be built with total knowledge of the real workflows — not an idealised
version of them. Where the platform's own briefs propose a *future* model (job families, Sales V2,
the training delivery engine), this document says so explicitly and separates **what exists now** from
**what is proposed**.

**How it was produced.** Read-only inspection of the repository: the FastAPI route layer
(`api/*.py`, ~120 route modules registered in `api/main.py`), the schema
(`core/migrations.py`, `sql_migrations/*.sql`, and the partial `schema.sql` dump), the domain services
(`services/*.py`), and the platform's own design briefs (`JOB_TYPE_AND_WORKFLOW_BRIEF.md`,
`TRAINING_WORKFLOW_BRIEF.md`, `BUSINESS_DEVELOPMENT_REDEVELOPMENT_BRIEF.md`, `llms.txt`). No code or
data was changed.

**Status legend used throughout:**

- **[LIVE]** — implemented and in the running product.
- **[PARTIAL]** — implemented but incomplete, fragile, or inconsistent (detail given inline).
- **[PROPOSED]** — described in a brief but not yet built; carried here so the redesign inherits the intent.

---

## 1. What NZI Pro is

Net Zero International is a UK carbon & sustainability consultancy. **NZI Pro** (public name *NZ Insights
Pro*) is its proprietary multi-tenant platform for measuring, reporting and reducing greenhouse-gas
emissions for multi-site, multi-country organisations across Scopes 1, 2 and 3. It is built under the
GHG Protocol, GRI and the ISSB standards (IFRS S1/S2), and draws emission factors from UK DESNZ/DEFRA,
US EPA USEEIO, Europe FIGARO and the worldwide CEDA datasets.

Two truths shape every workflow:

1. **It is a consultancy tool first.** NZI consultants run the work; the client portal is a secondary,
   controlled surface. Every material output is "reviewed and verified by expert consultants" — software
   plus expert accountability, not automated estimates. The workflows are therefore built around an
   internal reviewer, an evidence trail, and a deliberate client-review gate.

2. **The Job is the spine.** Almost everything — data, factors, emissions, reports, invoices, portal
   publishing — hangs off a `jobs` record for one client and one reporting year. The platform is
   overwhelmingly built around one job family: the **Carbon Reduction Plan (CRP)**. Other service lines
   (Training, Consultancy, LCA, PCF) exist commercially but are only partly modelled in the data.

### 1.1 Technology shape (as-is)

| Layer | Reality |
|---|---|
| Backend | Python **FastAPI**, one app (`api/main.py`) including ~120 routers. |
| Frontend | **Next.js** (App Router, TypeScript) under `frontend/`. |
| Database | **PostgreSQL** (v17). Access via a small pooled connection helper (`core/database.py`), **autocommit**, max ~5 connections. |
| Migrations | `core/migrations.py` `run_migrations()` runs **on app startup**; plus numbered `sql_migrations/*.sql` (through `0068_*`). Several modules additionally create/alter their own tables **at request time** via `_ensure_tables` (see §14 — this is a known anti-pattern). |
| Identity | Two realms: **staff** (JWT + TOTP MFA) and **client portal** (separate login + MFA). Multi-tenant via `organisations` / `organisation_memberships`. |
| Files | Local disk or SharePoint/OneDrive (`onedrive_routes`, persistent uploads dir); virus scan on upload. |
| Reporting | HTML report engine + templated variables → PDF (Playwright/Kaleido, async) and DOCX. |
| Integrations | **Xero** (invoice/credit-note projection, OAuth + webhook), **Stripe** (org subscription billing), OpenAI/Gemini/Apollo/Companies House (business development), geocoding. |
| Ops | Sentry, in-app rate limiter, audit log, internal cron. |

### 1.2 The workspaces (what a consultant navigates)

The NZI Console scaffold already names the target workspaces, and they map cleanly onto the live route
groups:

| Console workspace | Live route groups behind it |
|---|---|
| **Control Room** (home) | `main_dashboard_routes`, `intelligence_routes` |
| **Clients** | `client_index`, `client_management`, `client_dashboard`, `client_notes`, `client_files`, `client_reporting`, `crm_timeline`, `crm_automation` |
| **Jobs** | `job_management`, `job_setup`, `job_scope_data`, `spend_data`, `employee_commuting`, `job_custom_factors`, `job_intensity`, `job_milestone`, `job_review`, `job_line_items`, `job_files`, `job_communications`, `job_training`, `job_consultancy` |
| **Emissions** | `job_scope_data`, `job_emission_register`, `emissions_reporting`/`monthly_emissions` services, `job_live_report` |
| **Datasets & factors** | `admin_datasets`, `admin_factor_definitions`, `custom_factors`, `dataset_import`, `databank`, `vehicle_lookup`, `spend_factor_refresh` |
| **Reports** | `report_template`, `report_actions`, `job_report`, `job_report_docx`, `job_report_pdf`, `pdf_generation`, `job_emissions_certificate`, `methodology`, `srs_readiness` |
| **LCA / PCF / CBAM** | `lca`, `lca_components`, `lca_suppliers`, `lca_activities` |
| **Business development** | `business_development`, `intelligence` (being redeveloped as *Sales V2*) |
| **Platform & audit** | `admin_*`, `auth`, `admin_users`, `admin_organisations`, `system_settings`, `admin_audit`, `admin_monitoring`, `admin_broadcasts`, `stripe_billing`, `xero`, `time`, `feedback`, `custom_fields`, `theme` |
| **Client portal** (separate surface) | `portal_auth`, `portal`, `portal_data_entry`, `portal_spend`, `portal_commuting`, `portal_vehicle`, `portfolio` |

---

## 2. Identity, tenancy & access

### 2.1 Two authentication realms [LIVE]

**Staff / consultant realm** (`api/auth_routes.py`, `api/auth.py`, `core/auth.py`):

- `POST /login` → optional `POST /login/mfa/verify` (TOTP). MFA setup/verify/disable, recovery codes.
- `POST /register` → `register/verify` (email verification) → membership of an organisation.
- `forgot-password`, `change-password`, `logout`, `GET /me`, `accept-portal-terms`.
- Strict mode (`APP_ENV=prod` or `ENFORCE_JWT_AUTH`) requires `NZI_JWT_SECRET` or the app refuses to boot.

**Client portal realm** (`api/portal_auth_routes.py`): entirely separate login, its own MFA, T&C
acceptance, password reset. Notably includes `portal/auth/staff-select-client` — a staff member can
impersonate/enter a client's portal context for support and preview.

> **Redesign implication.** The console must treat these as **two distinct principal types** with
> different session scopes and permission sets. The evidence drawer's "who last edited" and QA sign-off
> must know whether an actor was a consultant or a client portal user.

### 2.2 Multi-tenant organisations [LIVE]

`organisations`, `organisation_memberships`, `organisation_invitations` (`admin_organisations_routes.py`):

- Create org, patch, **invite** by email, accept invite by token, **switch** active org, list members,
  change member role, **transfer ownership**, **archive**.
- Per-org **billing** sub-resource (invoices, events) and **plan/capacity** gates: `org_admin_helpers`
  exposes `_require_org_capacity` (client limit) and `_require_org_plan_active` (job creation blocked if
  plan inactive). These are enforced at create-time in jobs/clients.

**Tenancy is application-enforced.** `services/tenancy.require_org` supplies the active org; repositories
add `org_id` predicates. The BD brief flags that the application DB role can bypass Postgres RLS, so
**application-level scoping is load-bearing** and any missing `org_id` filter is a cross-tenant risk.

### 2.3 Roles & permissions [LIVE, coarse]

`roles_lookup`, `core/auth.py`, `api/permissions.py` and `services/permissions.py`. Guards used across
routes: `assert_permission`, `assert_client_access`, `assert_job_access`. Default user role is
`ReadOnly`. Permissioning is real but **coarse and inconsistent** — some mutating routes (notably in
business development) apply no granular permission at all (see §11).

> **Redesign implication.** Adopt an explicit, tested **permission matrix** (like FuelCap's SoD matrix):
> named permissions per capability, server-enforced, with cross-domain checks on every handoff
> (job↔client↔quote↔portal).

---

## 3. Client management workflow [LIVE]

**Actors:** consultant / CRM owner. **Records:** `clients`, `client_sites`, `client_contacts`,
`client_notes`, `client_touchpoints`, `client_health_snapshots`, `portfolios_lookup`.

**The `clients` record is rich and target-aware.** Beyond firmographics (industry, company reg, HQ,
address, website, year-end month, logo), it carries the **net-zero trajectory** directly:
`net_zero_year` (default 2050), `interim_year` (default 2035), interim S1/S2/S3 reduction %,
per-scope `target_*_year` / `target_*_pct`, `benchmark_year`, `crm_owner`, `status`, `portfolio`.

**Lifecycle:**

1. **Create client** (`POST /clients`) — subject to org client-capacity limit. Logo upload
   (`/clients/logo-upload`, SharePoint-aware serving in `main.py`).
2. **Sites** (`/clients/{id}/sites`) — add/edit, **geocode** (`services/geocoding.py`), mark registered
   office, **vacate** a site (effective-dated — sites can close mid-period, which matters for reporting).
3. **Contacts** (`/clients/{id}/contacts`) — CRUD; contacts become report signees, portal candidates,
   quote/invoice recipients, training attendees.
4. **Notes & timeline** — `client_notes` plus the richer CRM timeline (§10).
5. **Targets** feed reporting: trajectory lines, interim milestones, and portal dashboards read the
   client's target fields.

**Client-facing surfaces:** `client_dashboard_routes`, `client_reporting_routes`, `client_index_routes`
(list + `/clients/{id}/jobs`). Client health snapshots and touchpoints power the "intelligence" and
call-prep views (§10).

---

## 4. The Job lifecycle — the core CRP workflow [LIVE]

This is the heart of the platform. A **Job** = one client × one reporting year × one service line
(overwhelmingly CRP). Everything below is per-job.

### 4.1 Job record & creation

`jobs` (core): `client_db_id`, `job_type_id` (+ `job_type` string, `crp_id`), `job_number` (unique),
`title`, `reporting_year`, `status` (default `Open`), `start_date`, `due_date`. CRP specifics live in
`crp_job_details` (reporting period from/to, benchmark flag, reporting year, renewal flag, client order
number, contacts, report signee, payment term, **free training place**, employees, turnover, premises
m², vehicles owned/leased, premises owned/leased).

`POST /jobs` (`job_management_routes.py`) — gated by `_require_org_plan_active`. Also writes the
**plan/milestones**:

- `job_plan`: `data_collection_due`, `first_draft_due`, `final_report_due`, `override_dates`.
- `milestone_templates` / `milestone_template_items` / `job_template_milestone_completions` — a
  configurable milestone checklist per job (`job_milestone_routes`, `milestone_template_routes`).

### 4.2 Scope configuration

`PUT /jobs/{id}/scope-config` (`job_setup_routes`) writes `job_scope_config` (per scope: `include_scope`,
`dataset_id`, `factor_method`). This decides **which of Scope 1 / 2 / 3 are in play and which factor
dataset each uses** — the single most important upstream decision for the whole calculation.

### 4.3 Getting activity data in

Multiple ingestion paths converge on **scope rows**:

- **Excel round-trip** (`job_setup_routes`): download a per-job `excel-template` → `excel-import-preflight`
  (validate) → `excel-import` / `excel-upload` (commit). Templates are generated from the job's scope
  config and available factors.
- **Manual entry** (`job_scope_data_routes`): `POST /jobs/{id}/scope-data` adds rows directly.
- **Spend-based Scope 3** (`spend_data_routes`): upload ledger spend → preview → commit → **map** each
  line to an emission factor (with AI category suggestion, `suggest-category` / `suggest-categories-bulk`),
  approve suggested mappings, **roll forward** prior-year mappings, then **sync-to-scope** to
  materialise spend into scope rows.
- **Employee commuting** (`employee_commuting_routes`): survey/template upload or **direct entry by
  vehicle**, monthly breakdowns, consolidation, review.
- **Custom factors** (`job_custom_factors_routes`, `custom_factors_routes`): client-specific factors when
  no dataset factor fits.
- **Previous-year reuse**: `previous-scope-rows`, spend `rollforward` — renewals copy last year's
  structure forward.

### 4.4 The scope row — the atomic unit of measurement [LIVE, central]

`job_scope_rows` is where activity data becomes emissions. Fields that matter for the console's evidence
model:

| Field | Meaning |
|---|---|
| `scope`, `level_1..4`, `column_text`, `report_label` | Classification + how it appears in the report. |
| `qty`, `uom` | Activity data and its unit. |
| `dataset_id`, `factor_db_id`, `original_id`, `factor`, `ghg_unit` | The matched emission factor and its provenance (which dataset, which factor row). |
| `calc_tco2e` | Computed emissions = `qty × factor` normalised to tCO₂e. |
| `override_tco2e`, `override_reason` | Manual override with a **mandatory reason** (audit trail). |
| `enabled` | Whether the row is included in the total. |
| `notes`, `created_at`, `updated_at` | Working notes + timestamps. |

**Calculation lineage (the console's signature feature) is exactly this chain:**
`activity (qty, uom)` → `factor matched (dataset → factor row, ghg_unit)` → `calc_tco2e` → optional
`override (reason)` → `enabled ⇒ counted in total`. The NZI Console mock data already encodes this
(`ScopeRow.lineage`, `provenance`, `factorMatched`, `status`), which confirms the redesign is
deliberately built around row-level provenance.

There is also a parallel/legacy `crp_scope_entries` table (scope, category, subcategory, amount, unit,
dataset, factor, tco2e, method, `is_archived`) — an earlier entry model. The redesign should **pick one
canonical scope-row model** and treat the other as migration input.

### 4.5 Row review & QA [LIVE]

`job_scope_data_routes` implements an explicit reviewer workflow:

- `PATCH …/scope-data/{row_id}/review` and `…/bulk-review` — mark rows reviewed.
- `GET …/scope-data/pending-review` — the QA queue.
- `POST …/scope-data/consolidate` — collapse/normalise rows.
- `POST …/scope-data/{row_id}/repoint` — **re-point a row to a different factor** (re-derives emissions).
- `GET …/scope-totals`, `…/template-factors[/top]` — running totals and factor suggestions.

Emission-source grouping for reporting lives in `job_emission_groups` / `job_emission_sources`
(`job_emission_register_routes` — 86KB, the "emission register").

### 4.6 Emissions calculation engine [LIVE]

Factors come from `factor_lookup` (keyed by dataset, scope, level_1..4, uom, ghg_unit, `factor`,
region, currency) plus custom factors (`custom_factors`, `custom_conversion_factors`,
`custom_factor_year_values`). `services/dataset_selector.py` resolves *which* dataset/factor applies for
a job+scope (`resolve_dataset_resolution`). `services/emissions_reporting.py`
(`exact_job_total_emissions`) and `services/monthly_emissions.py` compute totals, including monthly
distribution. Intensity metrics (per £turnover, per employee, per m²) via `job_intensity_routes`.

> **Redesign implication.** Emissions are a **derived quantity with full provenance**. The console must
> never present a tCO₂e number without the ability to expand its lineage (activity → factor set/version →
> calc → any override/estimate flag). Data-quality tiers (Measured / Estimated / Spend-based / Survey)
> are first-class and already modelled in the mock data — carry them through calculation and reporting.

### 4.7 History & audit

`GET /jobs/{id}/history`, `services/audit_log.record_audit_event` (with `fetch_row_dict` before/after).
Audit is a real cross-cutting service — the redesign should route every mutation through an equivalent.

---

## 5. Data-quality, factors & datasets (admin) [LIVE]

**Actors:** NZI admin / methodology owner. This is the reference-data backbone every job depends on.

`admin_datasets_routes` (74KB): datasets CRUD, archive, export, **import workbooks**
(`dataset-workbook` / `blank-upload-template`), factor CRUD per dataset, **bulk-normalise report
labels**, **cross-country audit** and **fix-cross-country** (guarding against a UK factor leaking into a
US job, etc.). `admin_factor_definitions_routes`, `admin_spend_lines_routes`, `spend_factor_refresh_routes`
(refresh spend factors when a dataset updates), `vehicle_lookup_routes` + `services/vehicle_lookup.py`
(reg-plate → vehicle → factor), `databank_routes`, `methodology_routes`.

Datasets carry `source`, `analysis_type`, `country`, `region`, `currency`, `year`, `version`,
`license` — i.e. **factor provenance and licensing are already modelled**. `factor_label_normalize` and
alias backfill migrations (`0052`, `0053`) show ongoing work to keep factor labels clean and prevent
cross-`original_id` merges.

**Portal data-entry buckets** (`admin_datasets_routes` `portal-data-entry-buckets`) define which activity
categories a client can self-serve in the portal, and which factors each bucket exposes.

> **Redesign implication.** "Datasets & factors" is a genuine admin workspace with data-governance
> weight: versioned datasets, licence terms, country/region scoping, label normalisation, and audit for
> cross-country contamination. The console's factor picker (already in the mock evidence drawer) is the
> consumer of all this.

---

## 6. Reporting workflow [LIVE]

Once emissions are computed and reviewed, the job becomes a **report**.

- **Templates** (`report_template_routes`, `report_templates` / `report_template_versions` /
  `report_template_variables`): versioned report templates with typed variables. Per-job assignment
  (`GET/PUT /jobs/{id}/report-template-assignment`), per-job variable values
  (`report-variables/{template_id}`), computed `report-data/{template_id}`, and `report-metadata`.
- **The report engine** (`job_report_routes`, 239KB — the largest module): assembles the HTML report
  from job data + template + variables + charts.
- **Charts**: `api/chart_generation.py` (matplotlib donuts/bars **and** Plotly+Kaleido pathway charts),
  plus `job_widget_pngs` (browser-rendered widgets **captured to PNG by a user** and cached per
  `(job_id, widget_id)`). Kaleido (Chrome) and Playwright (Chromium) are both provisioned/warmed at
  startup. **This is the platform's most-cited recurring dysfunction — see §6.1.**
- **Live report** (`job_live_report_routes`): a live, data-bound view (also surfaced in the portal).
- **Outputs**: PDF (`job_report_pdf_routes` / `pdf_generation_routes`, async queue —
  `services/pdf_generation_queue.py`), DOCX (`job_report_docx_routes`), report versions
  (`job_report_version_routes`, immutable snapshots), report manifest + validation, **emissions
  certificate** (`job_emissions_certificate_routes`).
- **Carbon-reduction actions** (`report_actions_routes`, `action_lever_framework` migration `0064`):
  a library of reduction actions and **action levers**, assigned per client
  (`/clients/{id}/report-actions`, `action-lever-summary`) — this is the "Plan" half of a Carbon
  Reduction Plan.
- **Report drafting AI** (`services/report_drafting.py`, `services/ai_insights.py`): AI-assisted
  narrative, grounded in job data.
- **SRS readiness** (`srs_readiness_routes`, migration `0065`): a UK Sustainability Reporting Standards
  readiness questionnaire per client.

> **Redesign implication.** Reporting is **template-driven with versioned variables and immutable
> published versions**. A report is a *composition* over reviewed scope rows + client targets + action
> levers + narrative. The console should preserve: template assignment, per-job variable capture,
> version snapshots, and the certificate/PDF/DOCX outputs — and keep the reduction-action library
> distinct from the measurement (scope rows).

### 6.1 Graphics pipeline — the recurring dysfunction [PARTIAL, fragile]

Graphics are a major part of NZI's delivery, and the pipeline that makes and shares them is the platform's
most-cited breakage. The as-is design causes this structurally:

- **Three chart-rendering mechanisms for one job:** (1) **matplotlib** (donuts/bars in
  `api/chart_generation.py`), (2) **Plotly + Kaleido** (pathway charts →
  `fig.write_image(engine='kaleido')`, needing headless Chrome), and (3) **captured browser widgets**
  stored in `job_widget_pngs` (`job_id`, `widget_id`, `png_data`, `captured_at`, **`captured_by`**). Three
  visual systems, no shared styling.
- **A fourth browser stack at runtime:** PDFs render report HTML through **Playwright/Chromium**; Kaleido
  needs its **own** Chrome. Both `services/kaleido_browser.py` and `services/playwright_browser.py`
  **download a browser at runtime** into ephemeral dirs (`/tmp/…`, `/var/data/…`), warmed on startup to
  avoid a "2-3 minute download cost" — the classic intermittent post-deploy failure on ephemeral disk.
- **Five divergent consumers:** the same PNGs are read by the HTML report (`job_report_routes` +
  `interactive_report.html` / `professional_report.html`), the live report, the review snapshot, the PDF,
  and the portal (`/portal/insights/widget-pngs`) — each can show a different version.
- **Charts are captured snapshots, not derived values.** `captured_by` shows a **human** snapshots each
  widget; after any data change the stored image is stale until re-captured.
- **The fix exists but was never wired in.** `api/report_manifest_validation.py` already computes
  `missing_required_widget` and `stale_widget_png` (`captured_at < jobs.updated_at`) as **errors**, and
  `api/report_manifests.py` defines a clean versioned manifest — but both say in their docstrings they are
  standalone and *not* wired into PDF/report/portal rendering. So today a report/PDF/portal view can be
  **published with stale or missing charts and nothing blocks it.**
- **A Redis/RQ PDF queue** (`services/pdf_generation_queue.py`) is a labelled "Phase 1" piece requiring
  Redis that may not be provisioned.

> **Redesign implication.** This is important enough to have its own design note: **`GRAPHICS_PIPELINE.md`**.
> The target is one SVG-first chart engine (`@nzi/charts`) rendering a single spec identically to screen,
> PDF and portal; charts **derived from reviewed data, never captured**; a **content-addressed** cache so
> staleness is impossible; the report **manifest as the only assembly path with validation as a hard
> publish gate**; and provenance on every chart so it expands in the evidence drawer like a scope row.

---

## 7. Client review & portal publishing [LIVE]

This is the deliberate gate between internal work and the client. `job_review_routes`:

1. `GET /jobs/{id}/review` — reviewer view; `review/comments` (threaded QA comments).
2. `review/generate-snapshot` — freeze a point-in-time snapshot of the report.
3. `review/send` / `review/send-to-portal` — release to the client portal.
4. `review/publish-pdf` — publish the PDF deliverable.
5. **Portal user administration** per client: `portal-candidate-users`, `portal-users` (create, patch,
   reset password, reset MFA, resend invite), `portal-access`, `portal-jobs` (which jobs a client can
   see), `portal-history`, `portal-login-history`, `portal-files`, and
   `jobs/{id}/portal-data-entry-expiry` (time-boxed client data-entry windows).

So the internal → client boundary is: **review → snapshot → publish → grant portal access → client sees
report and/or enters data within an expiry window.**

---

## 8. The Client Portal (client-facing surface) [LIVE]

A separate, controlled experience for the client's own users. Two jobs it does:

**A) See results** (`portal_routes`): `portal/dashboard`, `portfolio-dashboard` (multi-job),
`jobs/{id}` + `live-report-data` + `report-html` + `portal-snapshot-data` + `download-pdf`, threaded
`comments`, `approve` a job, `metrics`, `reporting-data`, `sites-geo` (map), `data-completeness`,
`ingestion-feed`, `status-bar`, `srs-readiness`, **carbon-reduction actions** (`actions/library`,
`from-library`, `levers`, `lever-summary`, patch/create client actions), `insights/widget-pngs`, `files`.

**B) Enter their own data** (client self-service, feeding the consultant's job):

- `portal_data_entry_routes`: activity **buckets** (defined by admin), per-bucket factors, previous rows,
  top factors, add/edit/delete rows. Mirrors the internal scope-row model but scoped to what the client
  is allowed to touch.
- `portal_spend_routes`: upload spend, categorise (with AI suggestion + confirm), manage rows.
- `portal_commuting_routes`: commuting entry, by vehicle, options/history.
- `portal_vehicle_routes`: vehicle lookup.

> **Redesign implication.** The portal is a **constrained mirror** of internal data entry: same scope-row
> and factor concepts, but governed by bucket permissions, portal-access grants, and data-entry expiry.
> The console redesign should share the data model and validation with the portal, not fork it.

---

## 9. Commercial workflow — quotes, invoices, credit notes [LIVE]

`quotes_routes` (162KB) is a full commercial engine:

- **Quotes**: `/clients/{id}/quotes` create; `approve`, `accept`, `revise` (versioned history), `email`,
  `pdf`, `email-pdf`, `email-preview`, `email-log`.
- **Invoices**: at client or job level; `jobs/{id}/line-items` (+ `apply-template`, `create-invoice`),
  `jobs/{id}/other-costs`, `convert-to-invoice` from an accepted quote, invoice PDF/email, history.
  `jobs_quote_id` migration (`0068`) links a job back to the quote that created it.
- **Credit notes** (`credit_notes_routes`): at client/job/invoice level, PDF/email, history.
- **Payment terms / VAT** lookups; **Stripe** (`stripe_billing_routes`) for org subscription billing;
  **Xero** (`xero_routes`) as the outbound accounting projection: OAuth connect, per-invoice and
  per-credit-note `sync`/`resync`/`status`, and a `webhook`. `xero_connections`,
  `xero_invoice_links`, `xero_contact_links` track the mapping.

**Commercial sequence (as-is):** quote → approve → accept → convert to invoice (or create invoice from
job line items) → sync to Xero. A job may be created from an accepted quote (`jobs_quote_id`).

> **Redesign implication.** NZI Pro's **canonical financial source of truth is its own ledger/invoices**;
> Xero is a projection. The BD redevelopment brief is emphatic that Client/Quote/Job creation must go
> through these **canonical services**, not be re-implemented — the console must reuse them.

---

## 10. CRM: timeline, tasks, automation, intelligence [LIVE]

- **Timeline** (`crm_timeline_routes`): per-client `timeline/events` (create/patch/archive/tag) and
  **tasks** (`clients/{id}/tasks`, patch, history, delete, `tasks/my`, open-count per client and per
  job, `email-recipients`). This is the day-to-day relationship record.
- **Automation** (`crm_automation_routes`): `automation/rules` (CRUD), `automation/runs`, `test-run` —
  rule-driven CRM actions.
- **Intelligence** (`intelligence_routes`): a CRM intelligence `dashboard`, **call-prep** per client,
  and `touchpoints` (`client_touchpoints`, `client_health_snapshots`) — relationship-health signals.
- **Messaging templates** (`messaging_templates_routes`, `services/messaging_templates.py`) and
  **outbound email** (`services/outbound_email.py`, `emailer.py`).

> **Redesign implication.** There is already a **client-scoped** activity/task model. The Sales V2 brief
> (§11) wants this generalised so activities/tasks can exist **before** a company becomes a client —
> important so the console does not build a second, incompatible activity history.

---

## 11. Business Development → Sales V2 [PARTIAL → PROPOSED]

`business_development_routes` (214KB, 26 routes) is the prospect→lead→opportunity→client/quote/job engine.
A dedicated redevelopment brief (`BUSINESS_DEVELOPMENT_REDEVELOPMENT_BRIEF.md`, 5 Aug 2026) assessed it
and recommends **containment and side-by-side replacement as "Sales V2"**, not more patching. Key
findings the redesign must respect:

- **Terminology collision:** "Lead" means three different things (AI-generated prospect, BD lead record,
  and first pipeline stage). Sales V2 fixes canonical terms: Prospect, Candidate, Company, Contact, Lead,
  Opportunity, Client, Activity, Task, Campaign, Search Profile, Prospecting run.
- **Truth vs availability:** several read endpoints convert exceptions into `HTTP 200` empty results, so
  "empty" and "failed" look identical. Empty / loading / degraded / failed / successful must be distinct.
- **Broken/unsafe handoffs:** the opportunity→job INSERT is malformed; conversions/quote/job creation run
  on autocommit and are neither atomic nor idempotent (repeat clicks duplicate records).
- **Destructive prospecting:** generation deletes the day's candidates *before* knowing a provider will
  return replacements; preview re-runs a new search on commit.
- **Weak tenancy/permissions:** an unscoped market-companies endpoint; mutations without granular
  permissions; no BD audit events.
- **Ungrounded AI:** prospects (companies, contacts, evidence URLs) are invented by a model without
  retrieval or source verification; the score repackages the model's own confidence.

The proposed target lifecycle:
`Prospect (New→Under Review→Promoted/Rejected) → Lead (New→Working→Qualified→Converted/Disqualified) →
Opportunity (open stages Discovery→Proposal→Negotiation, status OPEN/WON/LOST) → explicit Client/Quote →
Job on accepted quote or confirmed win`, with a versioned schema, background prospecting worker,
evidence-before-score, idempotent commands, and a transactional outbox.

> **Redesign implication.** In the console, **Sales** is a first-class workspace built on the Sales V2
> principles (Section 8/12–16 of that brief), reusing canonical Client/Quote/Job services. It is the one
> module where the redesign is also a *re-architecture*, not just a re-skin.

---

## 12. LCA / PCF / CBAM [LIVE, newer]

A methodology-heavy, product-oriented workspace built on jobs (`lca_routes` 159KB, plus
`lca_components`, `lca_suppliers`, `lca_activities`; migrations `0058`–`0067`).

Model: per-job **assessments** → **line items** (bill of materials) → **transport legs** (geocoded,
`services/lca_transport.py`) → **factor mapping** (search, map, gap-fill) → **recalculate** → **scenarios**
(compare variants) → **report** / inventory-breakdown export. Supporting: material categories, EN 15804
modules (A1–A3 etc.), a supplier library, factor **confidence & readiness** scoring
(`lca_factor_confidence_and_readiness`), BOM upload/template. Follows ISO 14040/14044 (LCA), ISO 14067
(PCF), ISO 14025 / EN 15804 (EPD).

> **Redesign implication.** LCA shares the job spine and the factor engine but has its **own inner model**
> (assessment → BOM line → transport leg → factor). The console should treat it as a distinct job family
> with its own workspace, reusing factors, provenance and the evidence drawer, not the CRP scope-row grid.

---

## 13. Training & Consultancy [PARTIAL / PROPOSED]

- **Consultancy** (`job_consultancy_routes`, small): a light wrapper for advisory work.
- **Training** (`job_training_routes`, 163KB — substantial but job-embedded). The
  `TRAINING_WORKFLOW_BRIEF.md` proposes a full delivery engine that does **not** yet exist as separate
  tables: training **products** → **course runs** → **sessions** → **bookings** → **attendance** →
  **entitlements** (free CRP-linked places, tracked available→reserved→consumed) → **certificates** →
  trainers/venues, plus reminders, invoicing hooks and a training-specific reporting layer. Today,
  `crp_job_details.free_training_place` is the only concrete link between a CRP and a training seat.

The **job-family model** (`JOB_TYPE_AND_WORKFLOW_BRIEF.md`) is the umbrella both briefs assume:
one shared `jobs` table, a canonical `job_family` (`crp` / `training` / `consultancy` / `lca` / `pcf`)
mapped from the existing `job_types` lookup, per-family detail tables, and a structured workflow model
(`job_workflow_templates` / `job_workflow_stages` / `job_stage_history`). **Partially built:** the
classification layer landed — `core/migrations.py` adds a `job_family VARCHAR` column to **both**
`job_types` and `jobs`, and it is read across the platform (job management, dashboards, reporting,
lookups). But the **structured workflow tables do not exist** (`job_workflow_templates`,
`job_workflow_stages`, `job_stage_history` — no references anywhere), so stage progression is still
implicit: jobs remain CRP-shaped with `crp_job_details` + `job_plan` + a milestone checklist, not an
explicit staged workflow with history. Per-family detail beyond CRP is likewise thin.

> **Redesign implication.** The console can implement the *intended* family/stage model cleanly from the
> start: a shared job header + `job_family` + per-family detail + explicit workflow stages with history —
> exactly what the briefs ask for, and what the FuelCap approach (workflow templates + stage history)
> already demonstrates.

---

## 14. Cross-cutting concerns & known weaknesses

Patterns that repeat across modules and must be **decided once** in the redesign:

| Concern | As-is reality | Consequence for redesign |
|---|---|---|
| **Request-time DDL** | Several modules run `_ensure_tables` (create/alter/seed) on ordinary API requests; `run_migrations()` also runs on startup. | Schema drift, latency, race risk. Redesign: **migration-owned schema only; no request-time DDL.** |
| **Autocommit, ~5-conn pool** | `core/database.py` autocommit; long external calls hold connections. | Multi-step ops aren't atomic; pool exhaustion. Redesign: **explicit transactions, idempotency keys, background workers for long/external work.** |
| **Fail-open reads** | Some endpoints return `200` + empty array + a `warning` on failure. | "Empty" == "failed". Redesign: **distinct empty/loading/degraded/failed/success states; structured error contract.** |
| **Audit** | `record_audit_event` exists and is used widely. | Keep and standardise: **every mutation + transition audited (actor, org, before/after, correlation id).** |
| **Provenance** | Datasets/factors carry source/version/licence; scope rows carry dataset+factor+override reason. | Strong foundation — **make provenance mandatory and always expandable in the UI (evidence drawer).** |
| **File storage** | Local disk or SharePoint/OneDrive; persistent uploads dir; virus scan. | Abstract behind one storage service; keep virus scan + provenance. |
| **AI** | `ai_prompt_*` registry/compiler/runs; `ai_insights`, `report_drafting`, spend categorisation, BD generation. | Keep AI **task-specific, grounded, and advisory**; never let it be the source of truth (esp. prospects, factors). |
| **Rate limiting / Sentry / cron** | In-app limiter, Sentry, `internal_cron_routes`. | Retain as platform services. |

---

## 15. End-to-end: the canonical CRP journey (as it runs today)

Putting it together, the real happy-path for the flagship service:

1. **Win the work.** (BD/Sales →) client exists; quote created, approved, accepted.
2. **Open the job.** `POST /jobs` (org plan active) → CRP details, `job_plan` dates, milestones seeded.
3. **Configure scopes.** `PUT scope-config` — choose Scopes 1/2/3, dataset + factor method per scope.
4. **Collect data.** Excel round-trip and/or manual scope rows; spend upload → map → sync-to-scope;
   commuting entry; custom factors; optionally the **client** enters data via the portal within an
   expiry window.
5. **Compute.** Each scope row: activity × matched factor → `calc_tco2e` (+ overrides with reason);
   totals via `emissions_reporting` / `monthly_emissions`; intensities.
6. **Review & QA.** Reviewer works the pending-review queue, repoints factors, consolidates, comments,
   sign-off; group into the emission register.
7. **Report.** Assign template + variables → generate HTML → charts → **version snapshot** → PDF/DOCX +
   emissions certificate; attach carbon-reduction **action levers**; AI-assisted narrative.
8. **Publish to client.** `review/send-to-portal` + `publish-pdf`; grant portal access; client views
   dashboard/report, comments, and **approves**.
9. **Bill.** Job line items → invoice (or convert accepted quote) → sync to Xero; credit notes if needed.
10. **Renew.** Next year: new job, `is_renewal`, roll forward prior scope rows / spend mappings; trajectory
    tracked against the client's net-zero/interim targets.

This is the workflow the NZI Console must carry forward **with total fidelity** — while fixing the
cross-cutting weaknesses in §14 and cleanly modelling the job families the briefs describe.

---

*Companion documents: `ARCHITECTURE.md` (the target architecture for NZI Console) and `DECISIONS.md`
(the decision register seeded from this deep-dive).*
