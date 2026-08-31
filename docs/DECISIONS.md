# NZI Console — Decision Register

A running log of the architecture and workflow decisions for **NZI Console**, in the style used for
FuelCap. Each decision has a stable ID (`NZC-###`), a status, and a short rationale. This register is the
single source of truth for "why is it built this way"; `ARCHITECTURE.md` and `WORKFLOWS.md` are its
supporting context.

**Status meanings**

- **Confirmed** — decided and reflected in the scaffold/deployment; change only via a new decision.
- **Proposed** — recommended from the deep-dive; needs Francis's sign-off before it's load-bearing.
- **Open** — a real choice that must be made before the relevant phase; options captured below.

**How to use it:** when a decision is made, set its status to *Confirmed* and date it; when a new question
arises, add the next `NZC-###`. Keep entries short — link out to the two companion docs for detail.

---

## Index

| ID | Decision | Status |
|---|---|---|
| NZC-001 | Additive, isolated environment — never touch production | Confirmed |
| NZC-002 | Design-first on mock data before any backend | Confirmed |
| NZC-003 | Design tokens: Inter + emerald palette | Confirmed |
| NZC-004 | App shell: rail · command bar · main · evidence drawer | Confirmed |
| NZC-005 | Evidence-drawer-first; provenance + calculation lineage mandatory | Confirmed |
| NZC-006 | Five explicit UI states — truth before availability | Proposed |
| NZC-007 | The Job is the spine; job families are first-class | Proposed |
| NZC-008 | One canonical scope-row model | Confirmed (24 Aug 2026) |
| NZC-009 | Explicit workflow stages with per-job history | Proposed |
| NZC-010 | Data-quality tiers are first-class metadata | Confirmed |
| NZC-011 | Factor/dataset provenance, versioning & cross-country audit | Proposed |
| NZC-012 | Reuse canonical Client/Quote/Job/Report services | Proposed |
| NZC-013 | Migration-owned schema; no request-time DDL | Proposed |
| NZC-014 | Atomic, idempotent commands | Proposed |
| NZC-015 | Tenant safety by construction | Proposed |
| NZC-016 | Two principal types; portal is a constrained mirror | Proposed |
| NZC-017 | Sales V2 — contain and replace Business Development | Proposed |
| NZC-018 | AI is task-specific, grounded and advisory only | Proposed |
| NZC-019 | LCA/PCF is a distinct family with its own inner model | Proposed |
| NZC-020 | Isolated-backend data strategy (synthetic by default; vetted anonymised subset for restricted testing) | Confirmed (24 Aug 2026) |
| NZC-021 | Reporting engine: rebuild natively in the isolated platform | Confirmed (24 Aug 2026) |
| NZC-022 | Explicit role-based permission / SoD matrix, refined by workspace | Confirmed (24 Aug 2026) |
| NZC-023 | Xero/Stripe sandbox-only during redesign | Proposed |
| NZC-024 | Separate job-family modules over a shared spine | Proposed |
| NZC-025 | Single shared job-numbering service · official `J000612` format · gapless | Confirmed (24 Aug 2026) |
| NZC-026 | One SVG-first chart engine (`@nzi/charts`) for all surfaces | Confirmed (24 Aug 2026) |
| NZC-027 | Charts derived from data, never captured; content-addressed cache | Confirmed (24 Aug 2026) |
| NZC-028 | Manifest-driven report assembly with validation as a hard publish gate | Confirmed (24 Aug 2026) |
| NZC-029 | One chart asset across screen/PDF/portal, with provenance; no runtime browser provisioning | Confirmed (24 Aug 2026) |
| NZC-030 | Dataset selection automated from reporting period, with audited manual additions | Confirmed (24 Aug 2026) |
| NZC-031 | Portal recovery remains staff-governed until verified outbound recovery infrastructure exists | Confirmed (27 Aug 2026) |
| NZC-032 | Monthly activity granularity aligned to the reporting period (with copy-to-all) | Confirmed (28 Aug 2026) |
| NZC-033 | Scope-row reporting hierarchy (level_1..4) + explicit report label | Confirmed (28 Aug 2026) |
| NZC-034 | Override tCO₂e + mandatory reason exposed in the write path | Confirmed (28 Aug 2026) |
| NZC-035 | One data-entry framework for portal and CRP; typed capture adapters | Confirmed (28 Aug 2026) |
| NZC-036 | Bulk-upload standard: Excel + paste grid + CSV mapper; one canonical download identity | Confirmed (28 Aug 2026) |
| NZC-037 | Company Vehicles replaces the Asset Register; non-vehicle assets via Data Entry | Confirmed (28 Aug 2026) |
| NZC-038 | Workspace design language: stage-as-section, named/numbered/colour-matched, collapsible, completed sinks | Confirmed (28 Aug 2026) |
| NZC-039 | Terminology: "carbon emissions" across all screens; "carbon footprint" reserved for the PCF (Product Carbon Footprint) module | Confirmed (29 Aug 2026) |
| NZC-040 | Date format: dd/mm/yyyy everywhere (UK), one shared formatter | Confirmed (29 Aug 2026) |
| NZC-041 | Client factors are first-class: reusable client/job-scoped `client_factors` with EPD evidence; rows carry factor source + is_custom_entry | Confirmed (29 Aug 2026) |
| NZC-042 | Sites are places, not labels: location + lifecycle (active/vacated) on client_sites; apply_pct apportionment on the row | Confirmed (29 Aug 2026) |
| NZC-043 | Per-entity source register + roll-up groups is the home for typed adapters, auto-generated into the canonical row | Confirmed (29 Aug 2026) |
| NZC-044 | Canonical row gains data_confidence, source_qty/uom conversion memory, column_text, and link fields | Confirmed (29 Aug 2026) |
| NZC-045 | The reporting taxonomy (level_1..4) is stored and controlled, not derived from the scope string | Confirmed (29 Aug 2026) |

---

## Decisions

### NZC-031 — Governed portal recovery [Confirmed 27 Aug 2026]
Client portal password and MFA recovery remains a staff-governed workflow in the isolated staging environment. The platform has no verified outbound-email and reset-token delivery service, so it must not present a self-service flow that cannot securely deliver or complete recovery. The public recovery route never confirms account existence and directs the client to their established NZI adviser relationship. An authorised administrator verifies the client outside the portal, revokes existing access, and issues a new single-use enrolment link. Self-service recovery may replace this only after email ownership, token expiry/consumption, rate limiting, audit, and account-enumeration controls are implemented and verified.

### NZC-001 — Additive, isolated environment [Confirmed]
NZI Console is a separate repo (`francis-nzi/nzi-console`) and Render service (`srv-d6o8snvgi27c73frfta0`),
additive only. It does not modify the live `nzi_pro_v7-POSTGRES` platform, its production database, or the
FuelCap environments. Rollback is deletion of the service + repo; nothing in production is affected.
*Source: `README.md`, `docs/DEPLOYMENT.md`.*

### NZC-002 — Design-first on mock data [Confirmed]
The first iteration runs entirely on `@nzi/mock-data` (illustrative, no PII), so the interaction model and
IA are proven before any backend is wired. Backend work targets a **non-production** Supabase/staging API
only, later. `NEXT_PUBLIC_APP_ENV=staging` is the authoritative "not production" signal.

### NZC-003 — Design tokens: Inter + emerald [Confirmed]
Type: **Inter** throughout (no Space Grotesk). Palette: Emerald `#0BA75E` primary, Deep Pine `#0B7A4B`,
Midnight `#0B1B2B`, Signal Amber `#FFC24B`, Drop Coral `#FF5C48`, Mint Tint `#DFF5E9`. Locked in
`packages/ui`.

**Amendment 30 Aug 2026 (WCAG 2.1 AA).** The rendered axe scan found the muted-text tokens below
WCAG-AA contrast. Brand colours (Emerald/Pine/Midnight/Amber/Coral/Mint) are unchanged; only muted greys
were darkened to pass 4.5:1: `--t3` `#8A968F` → **`#616B65`** (5.5:1 on white, 5.2:1 on `--paper`; an
initial `#6B7671` still failed on tinted backgrounds); `@nzi/charts` `tokens.muted` matched to `#616B65`;
rail muted `#5E7385`/`#6C8394` → `#7E93A6` (5.5:1 on Midnight); the `.nz-chart-flow` step badge uses
Midnight text on Emerald (5.6:1) rather than white.

**Open — emerald as text colour.** Emerald `#0BA75E` is also used as *text* (links, drawer kickers,
key-values, `@nzi/charts` subtitles) at ≈3.1:1 on white — fails AA. This is a brand decision, not a
mechanical fix: Deep Pine `#0B7A4B` passes, or introduce a darker emerald text token. It spans screen and
print (the charts token feeds the PDF/portal, NZC-026/029). Catalogued in `axe-baseline.json` (`fg`
`#0ba75e`) pending Francis. Emerald as fill/icon/border is unaffected.

### NZC-004 — App shell [Confirmed]
Left **Workspace Rail** · top **command/search bar** (⌘K) · main data area · right **Evidence Drawer**.
Implemented as `AppShell` / `WorkspaceRail` / `TopBar` / `EvidenceDrawer` in `@nzi/ui`. Nav declares the
target workspaces (Control Room, Clients, Jobs, Emissions, Datasets & factors, Reports, LCA/PCF/CBAM,
Business development, Platform & audit).

### NZC-005 — Evidence-drawer-first; provenance + lineage mandatory [Confirmed]
No emissions figure, score, or status appears without one-click access to its provenance and
**calculation lineage** (activity → factor set/version → calc → override/estimate flag → inclusion). The
mock `ScopeRow` type already models `lineage`, `provenance`, `factorMatched`, `quality`, and banner state.
This is the product's signature and mirrors the FuelCap evidence drawer.

### NZC-006 — Five explicit UI states [Proposed]
Every data surface distinguishes `empty`, `loading`, `degraded`, `failed`, `success`. A failed query is
**never** rendered as a successful zero. Directly addresses the live platform's fail-open reads
(`200` + empty + ignored `warning`). *Source: BD redevelopment brief §5.1.*

### NZC-007 — The Job is the spine; families first-class [Proposed]
One shared job header (client, `job_family`, number, reporting year, status, workflow stage, owner, dates,
quote link) + per-family detail tables + a canonical `job_family` ∈ {`crp`, `training`, `consultancy`,
`lca`, `pcf`} mapped from the existing `job_types` lookup. CRP experience preserved; other families
modelled cleanly rather than forced through CRP milestones. *Partially built in the live platform: a
`job_family` column already exists on both `job_types` and `jobs` and is read widely, but per-family
detail and staged workflow are still thin.* *Source: `JOB_TYPE_AND_WORKFLOW_BRIEF.md`; live
`core/migrations.py`.*

### NZC-008 — One canonical scope-row model [Confirmed 24 Aug 2026]
The live schema has **two** measurement models: `job_scope_rows` (qty/uom/factor/calc_tco2e/override,
factor-FK) and the older `crp_scope_entries` (amount/unit/factor/tco2e/method, `is_archived`). The console
must pick one canonical model and treat the other as migration input.

**Decision:** adopt `job_scope_rows` as the canonical emissions activity model. It is the source of truth
for calculation, QA, reports, charts and portal data entry. The older `crp_scope_entries` model is legacy
migration input only and must not remain a second write path or source of truth. This decision does not
force non-CRP families into the CRP scope-row workspace; LCA/PCF retain their own inner models while
sharing factor and provenance concepts where applicable.

*Confirmed by Francis, 24 Aug 2026. Unblocks: Emissions/Jobs data model.*

### NZC-009 — Explicit workflow stages with history [Proposed]
Model workflow as `workflow_template` → ordered `stage` → per-job `stage_history` (from/to, actor, time,
note), distinct from record lifecycle `status`. The stage tables (`job_workflow_templates`,
`job_workflow_stages`, `job_stage_history`) are **not present** in the live schema — stage progression is
implicit today — so build this cleanly from the start. *Source: `JOB_TYPE_AND_WORKFLOW_BRIEF.md`;
parallels FuelCap stage history.*

### NZC-010 — Data-quality tiers first-class [Confirmed]
Measured / Estimated / Spend-based / Survey are shown on the row, carried into totals, and flagged in the
report so a proxy is never mistaken for a measured figure. Already in the mock data and the drawer.

### NZC-011 — Factor/dataset provenance, versioning & cross-country audit [Proposed]
Datasets carry `source`, `analysis_type`, `country`, `region`, `currency`, `year`, `version`, `licence`;
every scope row records dataset + factor row + version. Keep the live platform's cross-country
contamination audit (a UK factor must not silently apply to a US job) and label-normalisation discipline.
*Source: `WORKFLOWS.md` §5; live `admin_datasets_routes`, migrations 0052/0053.*

### NZC-012 — Reuse canonical domain services [Proposed]
Client, Quote, Job, invoice and Xero/Stripe behaviour are canonical NZI Pro services. The console composes
them via the isolated API; it does not re-implement their SQL. NZI Pro's own ledger/invoices are the
financial source of truth; Xero is an outbound projection. *Source: BD brief §16, §7.1.*

### NZC-013 — Migration-owned schema; no request-time DDL [Proposed]
All schema comes from versioned migrations. Request handlers never create/alter/seed tables. Directly
fixes the live `_ensure_tables`-on-request pattern (schema drift, latency, race risk). *Source: BD brief
§5.6.*

### NZC-014 — Atomic, idempotent commands [Proposed]
Every multi-step operation (job create, conversion, handoff, publish, invoice) uses one explicit
transaction and completes once or rolls back completely; retries/double-clicks are absorbed via
idempotency keys + optimistic (row-version) locking. Fixes the live autocommit, non-atomic, repeatable
handoffs. *Source: BD brief §5.2, §12.3.*

### NZC-015 — Tenant safety by construction [Proposed]
Explicit `org_id` predicates in every repository operation + composite tenant foreign keys + least-
privilege RLS (application role `NOSUPERUSER NOBYPASSRLS`); missing tenant context defaults to denial.
Verified by a two-tenant isolation test suite. *Source: BD brief §5.5, §15.1.*

### NZC-016 — Two principal types; portal is a constrained mirror [Proposed]
Staff (JWT + MFA) and Portal (per-client, MFA, access grants, data-entry expiry) are distinct principals
with distinct scopes. The client portal shares the scope-row/factor model and validation with internal
data entry but is gated by bucket permissions and expiry — it is not a fork. *Source: `WORKFLOWS.md`
§2, §8.*

### NZC-017 — Sales V2 — contain and replace BD [Proposed]
Adopt the Business Development redevelopment brief: contain the legacy module, build **Sales V2**
side-by-side with canonical terminology (Prospect / Candidate / Company / Contact / Lead / Opportunity /
Campaign / Search Profile / Prospecting run), an unambiguous lifecycle (open stages Discovery → Proposal →
Negotiation with `OPEN/WON/LOST` status), evidence-before-score prospecting on a background worker, and
reuse of canonical Client/Quote/Job services. This is the one workspace that is a re-architecture, not a
re-skin. *Source: `BUSINESS_DEVELOPMENT_REDEVELOPMENT_BRIEF.md`.*

### NZC-018 — AI is grounded and advisory only [Proposed]
AI assists categorisation (spend), drafting (report narrative), and prioritisation against real evidence.
It is never the source of truth for factors, emissions, or prospect facts; prospect/company identity comes
from authoritative sources (e.g. Companies House) with stored, verifiable evidence. *Source: BD brief §14;
`WORKFLOWS.md` §14.*

**Confirmed application (28 Aug 2026, Francis).** AI **spend categorisation on data entry** is **task/row-specific, grounded and advisory only** — it suggests a category/factor from real dataset factors and the client’s own prior mappings, with visible confidence and evidence; a human confirms before any value changes, and the written row/mapping carries its provenance and quality tier. AI is never a second write path or a factor of record.

### NZC-019 — LCA/PCF is a distinct family with its own inner model [Proposed]
LCA/PCF shares the job spine and factor engine but has its own model: assessment → BOM line item →
transport leg → scenario, with factor confidence/readiness and a supplier library, following ISO
14040/14044, ISO 14067, ISO 14025 / EN 15804. It gets its own workspace, not the CRP scope-row grid.
*Source: `WORKFLOWS.md` §12; live `lca_routes`, migrations 0058–0067.*

### NZC-020 — Isolated-backend data strategy [Confirmed 24 Aug 2026]
**Synthetic data is the default** for development, demonstrations and routine testing. When migration,
compatibility or realistic edge-case testing requires it, a small production-derived subset may be used
only after passing a repeatable anonymisation pipeline, formal data-protection review and verification in
a restricted non-production environment.

The production-derived subset must never be committed to GitHub or included in this Render service. By
default, do not copy uploaded files, credentials, tokens, free-text notes, communications or personal
contact data. Replace or remove client-identifying and commercially sensitive fields, regenerate or
consistently remap identifiers, and verify the output before access is granted.

*Confirmed by Francis, 24 Aug 2026. Unblocks the Phase 3 data strategy, subject to approval of the
anonymisation pipeline before any production-derived data is copied.*

### NZC-021 — Reporting engine: rebuild natively [Confirmed 24 Aug 2026]
The isolated platform will **rebuild the reporting engine natively** rather than depend on the live
`job_report_routes` implementation. The rebuilt engine owns versioned templates and typed variables,
manifest-driven assembly, immutable report versions, validation, and HTML/PDF/DOCX/certificate outputs.
It uses the shared SVG-first `@nzi/charts` subsystem and makes validation a hard gate before publish, PDF
generation or portal release.

Rebuild does not mean discarding validated business content. Existing report structures, required
disclosures, calculation semantics and historical outputs are compatibility references and must be
covered by explicit acceptance fixtures. The new implementation must not call the live production
database or inherit human-captured chart assets, disconnected manifest validation, or runtime browser
downloads.

*Confirmed by Francis, 24 Aug 2026. Unblocks: Reports workspace and the isolated reporting architecture.*

### NZC-022 — Explicit permission / SoD matrix [Confirmed 24 Aug 2026]
Adopt explicit roles for **Administrator, Consultant, Reviewer, Finance, Methodology/Data administrator,
and Read-only** staff. **Portal user** remains a separate principal type with access limited to its own
client, granted jobs and permitted data-entry buckets/windows.

Roles resolve to named, server-enforced permissions per capability (including view/edit scope, change
stage, change factors, apply overrides, review, publish to portal, edit financials, manage datasets, run
prospecting and administer access). Cross-domain handoffs must re-check authorisation; hiding a control in
the UI is not enforcement. Staff portal impersonation/support access must be explicit and audited.

The detailed permission matrix will be improved iteratively as each workspace and workflow is designed.
High-risk controls remain load-bearing throughout that refinement: independent reviewer approval for
report publication and material emissions overrides; separately controlled finance and methodology
capabilities; reasoned administrator emergency overrides; and a complete audit trail.

*Confirmed by Francis, 24 Aug 2026. Unblocks: Platform & audit design and Phase 3 write paths, with the
capability-level matrix maintained as a living design artefact.*

### NZC-023 — Xero/Stripe sandbox-only during redesign [Proposed]
All accounting/billing integration runs in test/sandbox mode until a separate, explicit approval to wire
live. No live financial movement is initiated from the console during redesign. *Source: `WORKFLOWS.md`
§9; BD brief legacy-boundary principle.*

### NZC-024 — Separate job-family modules over a shared spine [Proposed]
CRP, Consultancy, LCA, PCF and Training are genuinely different work and are built as **separate workspace
modules** — each with its own workflow/stages, page designs, detail data model and report manifest — over
one **shared job spine** (header + numbering) and shared services (clients, factors, visualization,
commercial, files, audit, tenancy, permissions). Adding or changing one family does not touch the others.
Separation of modules must **not** fork the shared subsystems (esp. graphics — see NZC-026). Supersedes
the "families as detail under one Jobs workspace" framing in earlier drafts. *Source: user requirement,
24 Aug 2026; `JOB_TYPE_AND_WORKFLOW_BRIEF.md`; `ARCHITECTURE.md` §6.*

### NZC-025 — Single shared job-numbering service · official `J000612` format · gapless [Confirmed 24 Aug 2026]
All job numbers come from **one authoritative allocator** and are **sequential across every family** (a
CRP, an LCA and a training job draw from the same counter). Implemented as a single Postgres sequence or a
numbering table guarded by an advisory lock, allocated **transactionally and idempotently** with job
creation (NZC-014). Replaces today's ad-hoc free-form `jobs.job_number` unique varchar.

**Resolved knobs (Francis, 24 Aug 2026):**
- **Format — preserve the official universal `J` format.** Numbers are shown as `J000612`, `J000613`,
  `J000614` … regardless of job family. Store the bare integer and render it as `J` plus six zero-padded
  digits. Store `job_family` separately and show it as a badge/label (`CRP`, `CON`, `LCA`, `PCF`, `TRN`),
  never as part of the official job number.
- **Gap policy — guaranteed gapless.** No skipped numbers. The pragmatic implementation: **assign the
  number only at the durable creation of a real job**, inside the creating transaction — a draft/aborted
  creation never consumes a number, so the sequence stays contiguous without a heavy reserve-and-release
  scheme. If a design ever needs a number *before* commit, use a reservation table with explicit
  release/rollback; prefer assign-on-commit. Numbering must be covered by a concurrency test.

*Source: user requirement, 24 Aug 2026; `ARCHITECTURE.md` §6.3.*

### NZC-026 — One SVG-first chart engine for all surfaces [Confirmed 24 Aug 2026]
A single workspace package `@nzi/charts` renders a declarative chart spec to **SVG**, used identically on
the console screen, in the PDF and in the client portal. Replaces the live platform's **three** rendering
stacks (matplotlib + Plotly/Kaleido + human-captured `job_widget_pngs`). SVG-first removes the need for a
headless browser to draw charts. *Source: user requirement (graphics dysfunction), 24 Aug 2026;
`WORKFLOWS.md` §6.1; `GRAPHICS_PIPELINE.md`.*

### NZC-027 — Charts derived, never captured; content-addressed cache [Confirmed 24 Aug 2026]
A chart is a pure function of *(reviewed job data + spec + tokens + version)*. There is **no human capture
step**. Any cached render is keyed by a **hash of that input**, so a data change forces regeneration and
staleness is structurally impossible. Retires `job_widget_pngs` as a source of truth (at most a
content-addressed cache). Directly fixes the live stale/missing-image failures. *Source: `WORKFLOWS.md`
§6.1; `GRAPHICS_PIPELINE.md` §2, §3.4.*

### NZC-028 — Manifest-driven assembly with validation as a hard publish gate [Confirmed 24 Aug 2026]
Reports are assembled **only** from a versioned manifest (sections → required/optional charts), and
validation (missing / unresolved / incoherent chart) **blocks** publish, PDF and portal push. This adopts
and *wires in* the `report_manifests.py` + `report_manifest_validation.py` layer the live platform built
but left disconnected — so nothing is ever published with a missing or stale chart. *Source: `WORKFLOWS.md`
§6.1; `GRAPHICS_PIPELINE.md` §3.5.*

### NZC-029 — One chart asset across surfaces, with provenance; no runtime browser provisioning [Confirmed 24 Aug 2026]
The same rendered chart (same spec + data hash) serves screen, PDF and portal, and carries **provenance**
(job data, factor set/version, spec version) so it expands in the evidence drawer like a scope row. The
runtime download of Kaleido-Chrome and Playwright-Chromium is **eliminated**: charts are SVG (no browser),
and any single retained HTML/SVG→PDF renderer is **pinned and installed at build/deploy**, never fetched
into `/tmp` on first use. *Source: `WORKFLOWS.md` §6.1; `GRAPHICS_PIPELINE.md` §2.8, §3.3.*

### NZC-030 — Automated dataset selection with manual additions [Confirmed 24 Aug 2026]
Reporting-period dates drive automatic dataset selection, further constrained by geography, scope and
factor method where applicable. Consultants may add other datasets manually when required, but the
addition is explicit, requires a reason, retains the automatic recommendations, and is recorded in
provenance and audit history. Period or geography mismatches generate visible warnings and may require
reviewer approval. Existing calculated rows remain tied to their selected dataset/version until an
explicit recalculation. *Confirmed by Francis, 24 Aug 2026.*

**Addendum — previous-year rollforward (28 Aug 2026, Francis).** Carried-forward rows **re-pin the prior year’s factor versions** so year-on-year reporting stays consistent and comparable; moving a rolled-forward row onto a newer factor version is an explicit, audited recalculation (per the base decision above), never automatic.

### NZC-032 — Monthly activity granularity aligned to the reporting period [Confirmed 28 Aug 2026]
The canonical scope row (and portal entry) stores an **optional 12-slot monthly activity vector** with an annual roll-up derived from it. The month slots **follow the job’s reporting period** (`crp_job_details` reporting-from/to) — a non-January start or a short/long first year shows exactly those months, not a fixed calendar year. Preserve the live convenience that a value entered for the first month can be **copied across all months** (and quick fill/clear), so annual-shaped data stays fast to enter. Monthly distribution feeds seasonality charts, mid-period site open/close and portal monthly capture. *Parity-critical; schema-level. Confirmed by Francis, 28 Aug 2026.*

### NZC-033 — Scope-row reporting hierarchy & label [Confirmed 28 Aug 2026]
Adopt a controlled **category path (`level_1..4`)** plus an explicit **`report_label`** on the canonical scope row, replacing the free-text `scope` string. The label defaults from the matched factor and is overridable; the category path is the deterministic source for the report’s scope/category breakdown and chart grouping. A structured **scope selector** replaces hand-typed scope entry. *Parity-critical; schema-level. Confirmed by Francis, 28 Aug 2026.*

### NZC-034 — Override capture in the write path [Confirmed 28 Aug 2026]
The evidence-drawer editor exposes an **override tCO₂e with a mandatory reason** (the fields already exist on the read model and in lineage). Overrides are first-class and reasoned — recorded with actor/time, shown in lineage — reusing the reason-carrying command pattern already used for manual dataset additions. *Confirmed by Francis, 28 Aug 2026.*

### NZC-035 — One data-entry framework for portal and CRP; typed capture adapters [Confirmed 28 Aug 2026]
There must **not be two disparate data-input systems**. Client-portal and consultant CRP data entry operate under **one framework, one canonical scope-row model, and the same validation, provenance and review workflow**. Entry *kind* (manual activity / spend / commuting / vehicle / import) is handled by **typed capture adapters** that present kind-specific fields (VAT/GL for spend; vehicle registration / mode / WFH for commuting; the monthly vector for all) and kind-specific advisory automations — all writing the same canonical rows into the same review queue. The portal is a constrained mirror of the internal surface (NZC-016), never a fork. *Parity-critical. Confirmed by Francis, 28 Aug 2026.*

### NZC-036 — Bulk data upload: one standard, one download identity [Confirmed 28 Aug 2026]
Bulk activity upload is standardised across the three template-driven activity domains — **Employee Commuting, Company Vehicles, and Business Travel** — plus **Purchased Goods & Services via the spend pathway**, on **both the CRP and the portal**, all with **monthly input where available** (reporting-period-aligned per NZC-032) writing canonical scope rows through the shared review workflow (NZC-035). **PG&S is spend-based**, not a quantity template — it is captured through the **spend adapter** (ledger/invoice upload → AI-assisted categorisation → factor mapping → sync to **Scope 3.1** rows tagged with the controlled PG&S category, NZC-033), itself a bulk upload supporting monthly.

**Three input methods over one validation/preflight engine and one canonical schema:**
1. **Excel template round-trip** (baseline / offline) — download → fill → preflight → commit.
2. **In-browser paste-and-validate grid** (fast path) — paste rows from any spreadsheet; validate live (units, factor match, months, duplicates) with inline errors; commit. No file round-trip.
3. **Remembered CSV column-mapper** (client-native) — accept the client’s own export, map their columns to the canonical fields once, and **remember the mapping per client** so later years are one click.

Pull-data **connectors** (accounting for spend/PG&S, telematics/fuel-card for vehicles, HR/payroll for commuting headcount) are a later automation — noted, not scheduled.

**Canonical download identity — one shared service, no per-flow drift.** Every downloadable template/export (CRP and portal) is produced by a **single** filename+identity builder, replacing today’s divergent ones (`services/download_filenames.py`, the single-sheet generator’s own `f"{job_no} {client} {site} {year}.xlsx"`, and the hardcoded `portal_spend` `spend-data-template.xlsx`).
- **Filename (human label):** `{JobNumber}_{ClientName}_{JobName}_{ReportingYear}_{Descriptor}.xlsx`, underscore-separated, each identifier sanitised of `<>:"/\|?*` and collapsed whitespace — e.g. `J000712_BushyTailsLtd_AnnualCRP_2024_Commuting.xlsx`.
- **Embedded identity block (machine-readable, the source of truth):** every template carries a locked header block — immutable **JobId**, JobNumber, ClientName, JobName, ReportingYear, ReportingPeriodStart/End, Domain, **TemplateVersion**, and an integrity hash. **Upload preflight validates against the embedded JobId / period / version, never by parsing the filename** (retiring the live year-in-filename regex in `job_setup_routes.py`). A wrong-job or wrong-period file is a hard, clearly-explained block; an out-of-date template version is detected and handled.
- **Consistent headers across the activity domains:** identical identifier block and identical reporting-period month columns, with shared columns (Scope · Category/Report Label · ID · UOM · [reporting-period months] · Qty · Data Source · Notes) plus domain-specific columns (Company Vehicles: registration/type; Commuting: mode/distance-unit/WFH). The **spend template is the fourth canonical download** and adopts the same identity block — it is today’s worst offender (hardcoded `spend-data-template.xlsx`).
*Confirmed by Francis, 28 Aug 2026.*

#### NZC-036 amendment — B4 Excel/CSV import design [Confirmed 31 Aug 2026]
Elaborates the bulk-upload standard for the spend-import slice (B4); all under NZC-036.

- **Parsing:** in-browser, so the raw client ledger never reaches the server (isolation). **Revised
  31 Aug 2026 → CSV-first:** on install `exceljs` pulled ~98 transitive packages + a transitive moderate
  `uuid` CVE (not reachable in our use) and had not been released in ~a year, against a console with zero
  non-workspace deps. B4 ships CSV-first with **no new dependency** — a real in-browser CSV reader
  (RFC-4180 quoting, delimiter/BOM detection, formula-injection neutralisation) + a plain `.csv` template.
  The **`.xlsx` round-trip is a later slice** where the library choice (a maintained SheetJS release, or a
  lighter option) gets its own review. Flow unchanged: browser parses -> preview + column mapping ->
  **normalised rows posted to the isolated backend**, which issues a context token, preflights and writes.
- **Flag:** B4 gets its own value **`spend-import`** with its own acceptance gate and flip; B2/B3 stay live
  on `=spend`.
- **Undo:** every import is tagged `import_batch_id`; undo is an **audited soft-void** limited to rows still
  **pending / unsynced / unreviewed** (reviewed, synced, or snapshotted rows are excluded). Re-import is
  **idempotent** against batch/identity.
- **Remembered mapping:** a tenant-isolated **`client_import_mappings`** table (RLS, migration-owned — no
  runtime DDL), keyed `(organisation_id, client_id, import_kind)`, column->field map as jsonb, versioned and
  audited.
- **Download identity:** the identity **shape + encode/decode + the five preflight states** live in
  **`@nzi/contracts`** (shared by the in-browser parser and the server validator, so they cannot drift);
  **issuing** the token and **verifying** it against the job's current version live in
  **`@nzi/isolated-backend`**.
- **Round-trip vs import-only:** **CSV and paste-grid are import-only**, taking job identity from the app
  context (you are on the job); the route issues a fresh server-signed context token and preflight
  validates **content** (period coverage, units, factors). This is the whole of CSV-first B4. A future
  `.xlsx` round-trip would carry identity in workbook custom properties / a hidden locked sheet. Reserved
  CSV `# nzi:` comment rows are **explicitly rejected** as brittle (no CSV comment standard; Excel renders
  them as data and users break them on save).

Confirmed by Francis, 31 Aug 2026.

### NZC-037 — Company Vehicles replaces the Asset Register [Confirmed 28 Aug 2026]
The live **Asset Register** (individual Scope-1 vehicles/equipment grouped for roll-up) becomes a focused **Company Vehicles** bulk-upload domain (registration-aware, monthly). **Non-vehicle Scope-1 assets** (equipment and other sources) are captured through general **Data Entry** rather than a separate register, keeping one canonical row model; grouping/roll-up for reporting is retained via the scope-row category path (NZC-033). *Confirmed by Francis, 28 Aug 2026.*

### NZC-038 — Workspace design language: the stage drives the screen [Confirmed 28 Aug 2026]
Every workspace across NZI Console — the CRP job, all other job families, the admin workspaces, and the **client portal** — uses one shared design language, so the platform reads as a single product and the work always leads. The rules:

- **The workflow stage drives the screen.** Each stage is its own section; the **progress bar and the page correlate exactly**. Clicking a stage in the bar opens and scrolls to its section.
- **Sections are named in user terms**, matching the progress-bar labels (e.g. *Data Entry*, never “Canonical evidence register”). Each section header carries its **stage number, a tick when complete, and the stage’s colour** (a restrained sequential ramp), mirroring its node in the bar.
- **Every section expands/collapses** to control noise; a collapsed section shows a one-line status summary. **Completed sections sink to a “Completed — for occasional reference” zone at the bottom** — job setup/configuration especially, since it is referred to infrequently once done.
- **One slim status strip** replaces the hero/ring/metric-card stack; **detail opens in the evidence drawer on selection** (the register uses full width otherwise); working tables default **exception-first**. Once-per-job configuration is not shown with the same weight as the daily working surface.
- **The client portal is a constrained mirror** of the same language (NZC-016, NZC-035), not a separate visual system.

Reference prototypes (28 Aug 2026): the consultant CRP workspace and the client portal, both built in this language on J000712 data. *Confirmed by Francis, 28 Aug 2026 — supersedes the ad-hoc always-open-card layout seen in the live platform.*

---

## Decisions needing Francis first

There are currently **no Open decisions** in this register. Add new questions here as the detailed
workspace designs expose choices requiring Francis's approval.


### NZC-039 — Terminology: “carbon emissions”, not “carbon footprint” [Confirmed 29 Aug 2026]
All user-facing copy across every workspace and the client portal uses **“carbon emissions”** (or simply
“emissions”). The phrase **“carbon footprint” is reserved exclusively for the PCF (Product Carbon Footprint)
module**, where it is the correct term of art. Applies to labels, headings, buttons, chart titles, tooltips,
empty/help text, generated report and PDF copy, and email/notification text. Confirmed by Francis, 29 Aug 2026.

### NZC-040 — Date format: dd/mm/yyyy [Confirmed 29 Aug 2026]
All dates render as **dd/mm/yyyy** across every screen, the client portal, and generated documents/PDFs (UK
convention), from a single shared date formatter as the one source — no locale-default or ISO date rendering
in the UI. Reporting-period month labelling (NZC-032) is unaffected: month labels follow the reporting-period
start and remain calendar-indexed in storage. Confirmed by Francis, 29 Aug 2026.


### NZC-041 — Client factors are first-class [Confirmed 29 Aug 2026]
A reusable `client_factors` entity (organisation + client scoped, optionally pinned to a job), versioned and
geography-aware, carrying a supporting **evidence file (e.g. an EPD)** whose integrity **hash travels in the
row's provenance**. The canonical row gains `factor_source` (`dataset` | `client`), `client_factor_id`, and
`is_custom_entry`. Migration-owned (`0034_client_factors.sql`); never runtime DDL. Confirmed 29 Aug 2026.

### NZC-042 — Sites are places, not labels [Confirmed 29 Aug 2026]
`client_sites` gains address, `latitude`/`longitude`/geocode, and a lifecycle (`active_from`, `vacated_date`,
`archived`), so a mid-year opening/closure is a fact, not an inference. The canonical row gains `apply_pct`
to **apportion one source across sites** (`0035`). **Sub-question resolved 30 Aug 2026 — factors are not
site-scoped in the schema:** the canonical row already carries `site_id` and `factor_id` independently, so a
site on its own tariff (e.g. a renewable REGO contract) is captured as a per-site row with its own factor.
Auto-applying a site's preferred factor to its rows is a later UI convenience, not a model gap; revisit only
if consultants find themselves re-picking the same site factor repeatedly. Confirmed 29 Aug 2026; sub-question
closed 30 Aug 2026.

### NZC-043 — Per-entity source register + roll-up groups [Confirmed 29 Aug 2026]
Individual assets, vehicles and employees live in `job_emission_sources` (+ `job_emission_groups` for
roll-up), with a typed kind-specific `detail_json` (commuting / vehicle / spend / asset). This is the data
home for the typed capture adapters (NZC-035). Each roll-up lands in the canonical row as an
**auto-generated** entry (`source_id`, `linked_row_id`, `is_auto_generated`, `auto_pair_kind`) — `0036`.
Confirmed 29 Aug 2026.

### NZC-044 — Remaining canonical-row fields [Confirmed 29 Aug 2026]
The row gains `data_confidence` (H/M/L, a distinct axis from the quality tier), `source_quantity`/
`source_unit` (as-entered conversion memory), and `column_text` (report column heading, distinct from
`report_label`) — `0035`. Confirmed 29 Aug 2026.

### NZC-045 — Stored, controlled reporting taxonomy [Confirmed 29 Aug 2026]
The reporting hierarchy (`level_1..4`) is persisted and controlled per scope (already begun in `0030`),
rather than deriving `categoryPath` from the free-text scope string — the report breakdown/charts need a
deterministic category source (tightens NZC-033). Confirmed 29 Aug 2026.

*(NZC-008 resolved 24 Aug 2026: `job_scope_rows` is canonical; `crp_scope_entries` is legacy migration
input. NZC-020 resolved 24 Aug 2026: synthetic by default, with a vetted anonymised subset permitted only
for restricted migration/compatibility testing. NZC-021 resolved 24 Aug 2026: rebuild reporting natively
in the isolated platform. NZC-022 resolved 24 Aug 2026: explicit roles and named permissions, with the
detailed matrix refined per workspace. NZC-025 resolved 24 Aug 2026: official zero-padded `J` numbers over
one shared counter, with family stored separately; guaranteed gapless via assign-on-commit. NZC-026–029
confirmed 24 Aug 2026: one derived, provenance-bearing SVG chart system across console, PDF and portal,
with content identity and manifest validation as a hard publication gate. NZC-032–035 confirmed 28 Aug 2026: reporting-period-aligned monthly granularity with copy-to-all; scope-row hierarchy + report label; override-with-reason in the write path; and one shared data-entry framework across the portal and CRP. NZC-018 (spend categorisation) and the NZC-030 rollforward re-pin were confirmed the same day. NZC-036–037 confirmed 28 Aug 2026: a single bulk-upload standard (hardened Excel + in-browser paste grid + remembered CSV mapper) over one canonical download identity, and Company Vehicles replacing the Asset Register. NZC-038 confirmed 28 Aug 2026: a single stage-as-section workspace design language — named, numbered, colour-matched, collapsible sections with completed ones sinking to the bottom — applied site-wide including the client portal.)*

The **Proposed** items (NZC-006, 007, 009, 011–019, 023, **024, 026–029**) are recommendations ready to be
confirmed as a batch once reviewed — including the job-family module separation and the whole graphics
redesign, which are direct responses to the two requirements raised on 24 Aug 2026.
