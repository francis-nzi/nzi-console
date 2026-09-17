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
| NZC-022 | Explicit role-based permission / SoD matrix — the matrix is [`PERMISSION_MATRIX.md`](PERMISSION_MATRIX.md) | Resolved (11 Sep 2026) |
| NZC-023 | Xero/Stripe sandbox-only during redesign | Proposed |
| NZC-024 | Separate job-family modules over a shared spine | Confirmed (1 Sep 2026) |
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
| NZC-042 | Sites are places, not labels: location + lifecycle (active/vacated) on client_sites; apply_pct apportionment on the row. Site-scoped factors closed — factors live on the row, not the site; S3 unblocked | Confirmed (29 Aug 2026; fully closed 01 Sep 2026) |
| NZC-043 | Per-entity source register + roll-up groups is the home for typed adapters, auto-generated into the canonical row | Confirmed (29 Aug 2026) |
| NZC-044 | Canonical row gains data_confidence, source_qty/uom conversion memory, column_text, and link fields | Confirmed (29 Aug 2026) |
| NZC-045 | The reporting taxonomy (level_1..4) is stored and controlled, not derived from the scope string | Confirmed (29 Aug 2026) |
| NZC-046 | One data-entry UX: scope→category accordion from the dataset taxonomy (collapsed), site-as-context, identical field order across CRP & portal, progressive disclosure, smart-search factor field, virus-scanned uploads | Confirmed (31 Aug 2026) |
| NZC-047 | Client portal breadth (11 live areas) incorporated as M6 on the shared evidence spine + @nzi/charts (derived, not PNG), one design language, reviewed-snapshot-backed, phased & flag-gated; Strategy/Actions & SRS Readiness need new domain models | Confirmed (1 Sep 2026) |
| NZC-048 | Editable report sections: ordered, versioned sections with contentSource default/ai/client-edited, Reset-to-default + Regenerate, provenance | Confirmed (1 Sep 2026) |
| NZC-049 | Data-bound figure tokens: figures in report narrative resolve from the report snapshot as locked tokens, never free text — data-integrity survives editing | Confirmed (1 Sep 2026) |
| NZC-050 | Deterministic print-safe charts: report charts render as static inline SVG from the snapshot; one render-ready signal gates PDF; no request-time canvas | Confirmed (1 Sep 2026) |
| NZC-051 | Paged output discipline: repeating table-header groups, row-atomic breaks, live-PDF running header/footer, on-screen Continuous↔A4 page-break view; snapshot frozen on Mark Final | Confirmed (1 Sep 2026) |
| NZC-052 | LCA/PCF one model, two presets — PCF is `lca_assessments` with `standard='ISO 14067'` / cradle-to-gate; keeps the "Product Carbon Footprint" label per NZC-039 | Confirmed (1 Sep 2026) |
| NZC-053 | LCA component / supplier libraries are client-scoped or global (`client_id` NULL = shared), mirroring `client_factors` | Confirmed (1 Sep 2026) |
| NZC-054 | LCA inventory is flat — `lca_line_items` per EN 15804 module, no BOM tree; a multi-leg transport journey is an ordered, geocoded child table with the parent line caching the leg sum | Confirmed (1 Sep 2026) |
| NZC-055 | Family review spine — a family's atomic reviewed unit (LCA assessment / training run) is versioned with `expectedVersion`, carries provenance/lineage, `review_status` bound to a reviewed version; family reports from a content-addressed snapshot | Confirmed (1 Sep 2026) |
| NZC-056 | CRP↔Training only via `training_entitlements` (free places originate from the quote/commercial terms, manual CRP grant secondary; atomic available→reserved→consumed, no hard FK); LCA factors use the shared `emission_factors`/`client_factors` signature; consultancy stays light (no time-tracking engine) | Confirmed (1 Sep 2026) |
| NZC-057 | Four-stage CRP lifecycle: Setup → Data entry → Review & QA → Report & publish. "Factor mapping" is retired as a stage — factor selection happens inline at capture; unmatched-factor rows are a "Needs attention" exception within Data entry, not a stage. CRP-only (leave `pcf`). | Confirmed (4 Sep 2026) |
| NZC-058 | Lean capture + drawer refine: the entry form captures core fields only (matched type / activity, quantity + unit, site-context, save); factor override, quality tier, data confidence, evidence notes, supporting docs and reasoned override move to the row's detail drawer. CRM adopts the portal's core-fields-only capture model. | Confirmed (4 Sep 2026) |
| NZC-059 | Review & QA is the Data-Assurance stage: the aggregate Outputs tables (five-year trend, by scope, by site, audit, intensity) are the QA surface, in the same stage as row-level independent approval, under one sign-off that freezes the content-addressed snapshot Report consumes. Baseline year always shown with a BL pill; trend = baseline + current + prior three years; "% vs BL" is a dedicated column. Assurance is a right-hand overlay drawer so the data view keeps full width. | Confirmed (4 Sep 2026) |
| NZC-060 | Data-integrity gap engine: before sign-off the dataset must clear four flag types — (1) YoY movement beyond the NZC-018 50%/200% band read against the trend, (2) completeness (a category/site with prior-year data now absent), (3) zero/blank where a value is expected, (4) unmapped/uncalculated. Each gap is fixed (edit the row) or resolved-with-reason (recorded on the row's provenance). Sign-off is blocked while any gap is open. A "% vs BL" reduction driven by an *unresolved* flag renders neutral grey until the gap is resolved. | Confirmed (4 Sep 2026) |
| NZC-061 | Entry unit set: `mi` and passenger-distance units (`passenger.km`, `passenger.mi`) added to the per-row entry unit list (bulk paths already carry `mi`). | Confirmed (4 Sep 2026) |
| NZC-062 | Add rows from template: a fuzzy-matched search across the whole job factor library (every selected dataset + client factor, every scope/category) — the unscoped power-user path alongside the per-category smart-search. A pick stamps factor + scope + category + site into a fresh enabled `scope.row.create` row, quantity empty, pending; the search stays open for a multi-add run. | Confirmed (4 Sep 2026) |
| NZC-063 | Reuse Previous Year Rows: previous-year rollforward generalised from the spend-only register (`job_emission_sources`) to every canonical row type, via a new `job_scope_rows.rolled_forward_from_row_id` self-reference. Select specific prior-job rows (not "roll everything"); factor + hierarchy + site copied in, quantity empty, pending; the same moved-factor / not-in-selection / already-rolled-forward lineage the spend mechanism already surfaces. | Confirmed (4 Sep 2026) |
| NZC-064 | Client record reaches parity with the live CRM: Details / Targets / Address / Compliance carried onto `clients` (migration `0060`). **Wizard to add, tabs to edit** — `/clients/new` is a four-step wizard (only identity required), `/clients/[id]/edit` is the five-tab record. One atomic versioned `client.update` per save, not per-tab commands. **Sites stay job-scoped**; the client's Sites tab is a read-only roll-up. | Confirmed (9 Sep 2026) |
| NZC-065 | The baseline is a dated record, not fields on the client: `client_baselines` (period, either a baseline job or typed scope figures, `kind`, `source`, reason, `effective_from`, `superseded_at`) replaces the mutable baseline fields on `clients`. Supersedes the baseline fields of NZC-064 only. | Confirmed (10 Sep 2026) |
| NZC-066 | Issued reports stamp the baseline they were issued against (`baseline_id` + the figures used + `resolved_at`); a draft still resolves live. The dated record is the policy, the stamp is the reproducibility. | Confirmed (10 Sep 2026) |
| NZC-067 | One `resolveBaseline()`; the rule "never look earlier than the baseline in force" lives in it and nowhere else. Replaces the live platform's eleven independent implementations. | Confirmed (10 Sep 2026) |
| NZC-068 | Targets **pin** to the baseline record they were set against, with a governed **recalculate baseline** event (reason required, prior baseline retained, audit-logged) as the only way to re-base — matching GHG Protocol / SBTi base-year recalculation policy. | Confirmed (10 Sep 2026) |
| NZC-069 | Console commercial ledger is the source of record; Xero is a downstream projection and payment-reconciliation source only. Implementation parked on its own branch (`feat/commercial-ledger`, PR #140), not for merge. | **Held** — revisit in a dedicated quotes/invoices exercise |
| NZC-070 | Sites are effective-dated, never hard-deleted. The reporting boundary for a job is the set of sites in service at any point in its **reporting period** (financial year): `(in_service_from IS NULL OR in_service_from <= period_end) AND (vacated_effective IS NULL OR vacated_effective > period_start)`. One resolver governs trend, gap engine, snapshot issue, report roll-ups and charts; rows outside the boundary raise a gap. One registered office per client. | Confirmed (11 Sep 2026) |
| NZC-071 | Site floor area is effective-dated (`client_site_floor_areas`); the per-m² intensity denominator is the sum of the in-boundary sites' floor area for the reporting period, and is "unavailable" when any in-boundary site has none. Replaces the typed floor-area denominator. | Confirmed (11 Sep 2026) |
| NZC-072 | Forward targets are a record of their own (`client_targets`), distinct from the baseline: years and % reductions against the **benchmark read from the baseline in force**, versioned and audited. The reduction pathway and the target gap are both derived from that model — no fixed points. A re-baseline **holds** targets; restating them onto the new benchmark is an explicit, reasoned act. | Confirmed (12 Sep 2026) |
| NZC-076 | **Strategy deadline reminders are emailed** by a separate background worker (`nzi-console-reminders`) that drains `transactional_outbox` on a 900 s clock, over **Office 365 SMTP** reading `SMTP_*` from the environment (matching live). Idempotent by **claim-before-send** on `strategy_automation_log`'s unique key. **Staging is suppress-and-log**, keyed off `NZI_DATABASE_BOUNDARY=isolated-non-production`; the worker refuses to boot without it. `email_consent` defaults to `unknown`, which holds. Verified on staging 14 Sep 2026. **Two production gates intentionally open:** consent capture, and a live worker standup. | Confirmed (14 Sep 2026) |
| NZC-075 | **Actions become Reduction Strategies** (ISO 14060 alignment) — never bare "Strategies", because `Strategy` is already an SRS pillar. The flat catalogue splits into **levers** (Admin-managed themes) and a shared **strategy library**, joined **many-to-many**: a strategy can sit under several levers, and the plan is grouped by lever. **Control level stays a separate single-value axis.** Capability `actions.manage` → `strategy.manage` at **matrix version 3**. Supersedes the model shipped in `0075`. | Confirmed (14 Sep 2026) |
| NZC-074 | A **trainee is a person, not a client's contact**: one record per individual, keyed on a changeable personal email, aggregating history across every employer. Employer and funding are frozen on each booking and never rewritten. Places are booked by consultant/CRM only — never self-serve from a portal. Certificates are **publicly verifiable** at `/verify/<code>` through a SECURITY DEFINER function whose return list is the whole contract. Changing the sign-in email requires verifying the new address first, and a former employer loses visibility of the person's new personal details. | Confirmed (13 Sep 2026) |
| NZC-073 | Training carries its own capabilities — `training.manage` (bookings, attendance, stage, certificate issuance) and `training.entitlement.manage` (moving a place's expiry) — held by Admin and Consultant, as peers of `actions.manage` / `srs.manage`. Run review stays `snapshot.review` (separation of duties); certificate issuance stays policy-gated on top of the capability. Matrix version 2. | Confirmed (13 Sep 2026) |

---

## Decisions

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

### NZC-022 — Explicit permission / SoD matrix [Resolved 11 Sep 2026 — see PERMISSION_MATRIX.md]
**Resolved.** The matrix is [`PERMISSION_MATRIX.md`](PERMISSION_MATRIX.md): five staff roles — **Admin,
Consultant, Reviewer, Finance, Viewer** (default Viewer) — and an exhaustive list of capability names. It
supersedes the six-role list below (Administrator → Admin; Read-only and Methodology/Data administrator →
Viewer, least privilege; dataset/factor management is Admin-only in the matrix). How it is enforced:

- **One enum.** The capability names live in `@nzi/contracts` (`capabilities`), and every command names
  one of them — typed, so an ad-hoc string cannot compile. The legacy strings (`emissions.data.edit`,
  `reports.publish`, `financials.edit`…) are gone; a test fails if one reappears.
- **Migration-owned, versioned config.** Role → capability rows are `staff_role_capabilities` (migration
  0066, matrix version 1); a principal resolves its capabilities from the current version at sign-in. The
  code copy (`ROLE_CAPABILITY_MATRIX`) is held equal to the migration rows by a test.
- **Authoritative in the command layer.** The command runner refuses a command unless the principal's grant
  holds its capability, the record is in the caller's tenant (`assert_client_access` /
  `assert_job_access`), and an *own clients* grant is used on a client the caller owns
  (`clients.owner_user_id`). The UI reads the same set (`/api/auth/me`) to gate controls.
- **Separation of duties.** A reviewed snapshot is prepared by one person and approved (`snapshot.review`)
  by another; a report is validated and published (`report.publish`) only from an approved snapshot and
  never by its preparer. A scope row cannot be approved by whoever captured *or* calculated it.
- **Governed re-baseline.** Changing an existing baseline (the client's, or a job target's) needs
  `baseline.rebaseline` (Consultant: own clients), always a reason, and writes a `baseline_change_events`
  row plus its own audit event, whatever the role.

*The original confirmation (24 Aug 2026), kept for the record:*


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

### NZC-024 — Separate job-family modules over a shared spine [Confirmed 1 Sep 2026]
CRP, Consultancy, LCA, PCF and Training are genuinely different work and are built as **separate workspace
modules** — each with its own workflow/stages, page designs, detail data model and report manifest — over
one **shared job spine** (header + numbering) and shared services (clients, factors, visualization,
commercial, files, audit, tenancy, permissions). Adding or changing one family does not touch the others.
Separation of modules must **not** fork the shared subsystems (esp. graphics — see NZC-026). Supersedes
the "families as detail under one Jobs workspace" framing in earlier drafts.

**Confirmed by Francis, 1 Sep 2026.** Families become first-class workspace modules over the shared spine;
the generic `FamilyWorkspace.tsx` ternary is retired. **Prove the model first** per non-CRP family (the
schema batch in `MODEL_FIDELITY_JOB_FAMILIES.md` — domain model + worst-case fixtures + migration), then
build **one LCA reference module** behind a flag, prove it, replicate. CRP stays canonical and untouched.

*Update (NZC-057, 4 Sep 2026):* the **CRP** module shell is now **four** stages — Setup → Data entry →
Review & QA → Report & publish. "Factor mapping" is retired (mapping is inline at capture). The `StageSection`
/ `StageFocusStrip` components and the `job-stage-sections` flag from UX1e-1 (#71/#72) are kept; the shell
loses one section. Other families (esp. `pcf`) keep their own stage sets.
**Phase 0 (migrations + fixtures + invariants, no UI) is complete** — `0045`–`0050` on `main`, applied to
isolated staging (PRs #63/#64/#65); its five schema decisions are registered as **NZC-052–056**. The **LCA
reference module waits** until the report (R-track, NZC-048–051) and data-entry (UX1 + adapters) tracks
land. *Source: user requirement, 24 Aug 2026; `JOB_TYPE_AND_WORKFLOW_BRIEF.md`; `ARCHITECTURE.md` §6;
`MODEL_FIDELITY_JOB_FAMILIES.md`.*

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

### NZC-031 — Governed portal recovery [Confirmed 27 Aug 2026]
Client portal password and MFA recovery remains a staff-governed workflow in the isolated staging environment. The platform has no verified outbound-email and reset-token delivery service, so it must not present a self-service flow that cannot securely deliver or complete recovery. The public recovery route never confirms account existence and directs the client to their established NZI adviser relationship. An authorised administrator verifies the client outside the portal, revokes existing access, and issues a new single-use enrolment link. Self-service recovery may replace this only after email ownership, token expiry/consumption, rate limiting, audit, and account-enumeration controls are implemented and verified.

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

#### NZC-036 / NZC-016 amendment — B5 portal spend mirror design [Confirmed 31 Aug 2026]
The client-portal spend capture is the constrained mirror of the B2 consultant spend adapter, built over
the existing portal data-entry framework (`entry_kind='spend'` already bound to scope 3.1). Directions:

- **Flag `portal-spend`** — its own acceptance gate and its own flip. Because the surface is client-facing,
  the **flip** additionally clears the portal acceptance suite (cross-client isolation, CSRF/same-origin,
  rate-limiting, stale-session, rendered a11y), not just functional tests.
- **B5 = paste + manual only.** Client **file upload (CSV) is B5.1**, its own hardening slice — untrusted
  external input gets type/size/row limits + preflight, **reusing B4's RFC-4180 parser**, not a re-write.
- **Monthly mirrors B2** (same component + validation, NZC-032-aligned) but **progressive**: annual by
  default, a collapsible monthly expander.
- **Allowed PG&S categories on the bucket grant** — `allowed_pgs_category_ids text[]` alongside
  `allowed_factor_ids` / `allowed_site_ids` (migration-owned); the client picks only from that set. Factor
  mapping and sync-to-scope stay **staff-side**; submitted spend routes to independent review and never
  counts as reviewed; any AI category suggestion is bounded to the allowed set and advisory (NZC-018).
- **Pre-flip check:** if the portal has gone client-live, green the portal P-track and pilot one client
  before a full flip. Portal is not client-live in staging as of 31 Aug 2026.

See `docs/ACCEPTANCE_B5_PORTAL_SPEND.md`. Confirmed by Francis, 31 Aug 2026.

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

**S2 amendment — lifecycle surface [Confirmed 31 Aug 2026].** The `client_factors` entity gains a full
lifecycle behind the flag **`client-factors`** (`ACCEPTANCE_S2_CLIENT_FACTORS.md`, D-S2-1..4):
**D-S2-1** EPD evidence is a **reference + integrity hash** (SharePoint item / URL + SHA-256), not an
uploaded blob — the hash travels in provenance. **D-S2-2** versioning is **mutate-and-bump**: a change to
a value-bearing field (`unit` / `kgco2e_per_unit` / `geography` / `vintage_year`) increments `version`, a
label/description/source edit does not; scope rows keep the `factor_version` they recorded and show a
non-blocking `clientFactorVersionMoved` advisory (NZC-030 re-pin discipline). **D-S2-3** the primary
manage view is **client-level** (Clients → a client → Emission factors), with a compact quick-add panel in
the CRP job. **D-S2-4** archive is blocked while an enabled non-rejected scope row references the factor.
`client.factor.create` is unchanged and job-contextual; a `clientId`-based create is a later convenience.

### NZC-042 — Sites are places, not labels [Confirmed 29 Aug 2026]
`client_sites` gains address, `latitude`/`longitude`/geocode, and a lifecycle (`active_from`, `vacated_date`,
`archived`), so a mid-year opening/closure is a fact, not an inference. The canonical row gains `apply_pct`
to **apportion one source across sites** (`0035`). **Sub-question resolved 30 Aug 2026 — factors are not
site-scoped in the schema:** the canonical row already carries `site_id` and `factor_id` independently, so a
site on its own tariff (e.g. a renewable REGO contract) is captured as a per-site row with its own factor.
Auto-applying a site's preferred factor to its rows is a **data-entry pre-fill only**, not a model
relationship: any such default is stamped onto the row's own `factor_id` at entry, stays fully editable,
and is recorded in lineage exactly like a hand-picked factor. There is **no resolve-time or compute-time
site→factor indirection** — a factor is never looked up through the site when a total or a derived
roll-up row is recomputed, so reviewed snapshots and S1/S3 group totals can never silently drift when a
site's default changes. The pre-fill itself is a deferred convenience (not built now); revisit only if
consultants find themselves re-picking the same site factor repeatedly. **S3 (sites-as-places) inherits
this settled model and is no longer gated by any NZC-042 decision.** Confirmed 29 Aug 2026; sub-question
closed 30 Aug 2026; fully closed 01 Sep 2026.

### NZC-043 — Per-entity source register + roll-up groups [Confirmed 29 Aug 2026]
Individual assets, vehicles and employees live in `job_emission_sources` (+ `job_emission_groups` for
roll-up), with a typed kind-specific `detail_json` (commuting / vehicle / spend / asset). This is the data
home for the typed capture adapters (NZC-035). Each roll-up lands in the canonical row as an
**auto-generated** entry (`source_id`, `linked_row_id`, `is_auto_generated`, `auto_pair_kind`) — `0036`.
Confirmed 29 Aug 2026.

**S1 amendment — group roll-up [Confirmed 31 Aug 2026].** A `job_emission_groups` group aggregates its
enabled members into **exactly one** auto-generated canonical row (linked by a new
`job_scope_rows.group_id`, `0043`), behind the per-domain flags `commuting` / `vehicle`
(`ACCEPTANCE_S1_SOURCE_REGISTER.md`, Q-S1-1..5):
**Q-S1-1** the roll-up row recomputes **deterministically from enabled members only**, **excludes those
members from the scope total** (no double count — cf. `3ed5810e`), carries provenance/lineage back to its
members, and is **not independently editable** (edits happen on members; a member change returns the row
to `pending`). **Q-S1-2** bulk paste for Employee Commuting / Company Vehicles is deferred to S1.1 / S1.2
(reuses the B4 parser). **Q-S1-3** per NZC-037, the register's add UI offers **vehicle + commuting only**
now — `source_type='asset'` stays a valid schema enum for legacy/roll-up rows but has no manual add path.
**Q-S1-4** `commuting` and `vehicle` flip **independently**. **Q-S1-5** the model/register is additive and
inert until a flagged surface reads it. **NZC-042 does not gate S1** — `site_id` is a plain assignment
reference here; site-scoped factors are S3.

### NZC-044 — Remaining canonical-row fields [Confirmed 29 Aug 2026]
The row gains `data_confidence` (H/M/L, a distinct axis from the quality tier), `source_quantity`/
`source_unit` (as-entered conversion memory), and `column_text` (report column heading, distinct from
`report_label`) — `0035`. Confirmed 29 Aug 2026.

### NZC-045 — Stored, controlled reporting taxonomy [Confirmed 29 Aug 2026]
The reporting hierarchy (`level_1..4`) is persisted and controlled per scope (already begun in `0030`),
rather than deriving `categoryPath` from the free-text scope string — the report breakdown/charts need a
deterministic category source (tightens NZC-033). Confirmed 29 Aug 2026.

### NZC-046 — One data-entry UX across CRP and portal [Confirmed 31 Aug 2026]
Data entry is a **scope→category accordion** using **dataset category names verbatim** (Scope 1/2 categories; the 15 GHG Scope 3 categories), collapsed so the user focuses on one at a time; the **CRM lists all 15 Scope 3 categories for completeness** (empties show a neutral "No data" and are excluded from reports), while the **client portal shows only authorised categories**. **Site is context** (chosen up front, auto-allocated). Portal and CRP are the **same capture component with the same field order** (Activity smart-search → Quantity/Unit → Monthly (under Quantity, collapsible) → category-specific detail → factor → note → documents); the portal is a constrained mirror (submit-to-review). **Progressive disclosure:** spend fields only under Purchased Goods and Services; the **registration finder** (DVLA) under Company Vehicles / Business Travel / Employee Commuting (client self-serve). The **factor is scope+category scoped and set from the selected activity** (hidden in the portal). **Supporting-document upload is virus-scanned server-side.** See docs/DATA_ENTRY_UX.md. Confirmed by Francis, 31 Aug–1 Sep 2026.

### NZC-047 — Client portal breadth [Confirmed 1 Sep 2026]
The live portal's eleven areas (Dashboard, Portfolio, Data Entry, Metrics, Strategy/Actions, Risk, Governance, SRS Readiness, Reports, Insights, Files) come into the redesign as **M6 · Client portal breadth**, on the **shared evidence spine** (read surfaces derive from the reviewed immutable snapshot) and **`@nzi/charts`** (derived SVG, replacing live's captured widget-PNGs), under **one design language** (left-nav for areas; stage-as-section for workflow surfaces), **flag-gated per area**. Mature read areas (Metrics, Insights, Portfolio, Dashboard) re-platform and may run in parallel with later data-entry slices; **Strategy/Actions** and **SRS Readiness** each need a **new domain model** confirmed before their UI; Risk/Governance/Files fold in as they stabilise. Catalogue: docs/GAP_ANALYSIS_PORTAL_BREADTH.md. Confirmed by Francis, 1 Sep 2026.

### NZC-048 — Editable report sections [Confirmed 1 Sep 2026]
A report is an ordered list of **versioned** sections, each with a `contentSource` of `default` (the NZI
template wording), `ai` (an AI redraft — the Report Preparation feature generalised to every section) or
`client-edited`. Editing is never a silent overwrite: each section carries provenance (who, when, source)
and the previous version is recoverable, exactly like a scope row. Every section offers **Reset to default**
and **Regenerate (AI)**; a status pill (Default / AI-drafted / Edited by client) is mirrored as a dot in the
section outline. Rich-text editing is scoped to the section body; structural furniture (headings, tables,
charts, sign-off) is not free-text. Editing respects the five UI states (unsaved ≠ saved).
*Source: `docs/REPORT_PRINTING_UX.md` §2; prototype `docs/prototypes/report_v3.html`.*
*Delivery: R2 (migration `0051`, `@nzi/contracts` `crpReportSectionCatalogue`, `report.section.edit` /
`report.section.reset`, snapshot freeze) lands the model + provenance + Reset — `docs/ACCEPTANCE_R2_SECTION_MODEL.md`.
R4 (`report-edit`) adds the in-place editor in the Report & publish stage + `report.section.regenerate`
(deterministic per-section AI variants; a live-model call is a tracked follow-up) —
`docs/ACCEPTANCE_R4_SECTION_EDITOR.md`. Report-surface rendering of the sections is R3 (`report-tokens`).*

### NZC-049 — Data-bound figure tokens [Confirmed 1 Sep 2026]
Figures embedded in report narrative are **not free text** — they are data-bound tokens resolved from the
report snapshot at render time (rendered as locked chips; the surrounding wording stays fully editable).
Consequence: the "Data integrity check passed" guarantee **survives arbitrary prose editing** — a client can
rewrite the Executive Summary and every figure still equals the canonical total — and a re-snapshot updates
the numbers with no re-typing and no stale figures. Tokens come from a fixed palette (total, scope
subtotals & %, category totals, intensity metrics, target %s, dates in dd/mm/yyyy), the same catalogue the
AI drafter draws from, so AI text is data-bound by construction. The report-side counterpart of the
data-entry governance spine: numbers have one source of truth.
*Source: `docs/REPORT_PRINTING_UX.md` §3.*
*Delivery: R3 (`@nzi/contracts` `reportTokens.ts` — 15-token catalogue, `resolveReportToken`,
`renderReportSectionBody`, `verifyReportSectionTokens`; token-embedded section templates; the report page
renders the R2 sections with resolved chips behind `report-tokens` and folds token verification into the
data-integrity banner + `data-report-ready`). `docs/ACCEPTANCE_R3_FIGURE_TOKENS.md`.*

### NZC-050 — Deterministic print-safe charts [Confirmed 1 Sep 2026]
Report charts render as **static inline SVG**, each a pure function of the frozen report snapshot — no
canvas, no chart library at render time, no network, no post-load layout. Fixes the recurring PDF breakage,
whose root cause is the PDF pipeline racing a client-side canvas render (half-drawn / zero-sized / size
mismatch). The PDF step waits on **one** deterministic render-ready signal (a `data-report-ready` flag set
once all sections and SVGs are in the DOM) — no arbitrary sleeps. Charts read from the same snapshot as the
tables, so a chart can never disagree with a table, and the data-integrity banner extends to cover charts.
Charts use the canonical `@nzi/charts` palette (Scope 1 coral / Scope 2 amber / Scope 3 emerald).
*Source: `docs/REPORT_PRINTING_UX.md` §1; `report_v3.html` (`donut()`, `bars()`, `pathway()`).*

### NZC-051 — Paged output discipline + running header/footer [Confirmed 1 Sep 2026]
Long tables use paged-media CSS so the header **group repeats on every page** a table spans
(`thead{display:table-header-group}`, `tr{break-inside:avoid}`, explicit `break-before`/`break-after`). The
surface offers a **Continuous ↔ Page view (A4)** toggle whose on-screen page map matches the generated PDF;
Continuous draws a "Page N break" marker at every boundary. Every page except the cover carries the live
PDF's running header (centred: client name over "Carbon Reduction Plan · <reporting period>") and footer
("Net Zero International" · job number · page number); header dates follow NZC-040 (dd/mm/yyyy) — the one
deliberate change from the live PDF's abbreviated-month format. On "Mark Final" the report version's
numbers, section text versions and chart source data are frozen together into one content-addressed
snapshot, so a re-print is byte-reproducible and an independent reviewer is bound to exactly what was signed
off. Production pagination uses a paged-media engine (server-side Chromium print, or a Paged.js-style
preview) so screen and PDF agree exactly.
*Source: `docs/REPORT_PRINTING_UX.md` §4–§5.*

### NZC-052 — LCA/PCF one model, two presets [Confirmed 1 Sep 2026]
PCF is not a separate model: it is `lca_assessments` with `standard='ISO 14067'`, cradle-to-gate, a
PCF-default module set — no `lca_pcf_*` tables (follows live `0058`, which dropped the never-used
`job_pcf_details`). The **"Product Carbon Footprint"** term keeps its one sanctioned home in the PCF
preset's UI and report labelling per NZC-039; the shared model does not remove it. Console migration
`0046_lca_assessments`. *Source: `MODEL_FIDELITY_JOB_FAMILIES.md` §2, §6.*

### NZC-053 — Client-scoped or global LCA libraries [Confirmed 1 Sep 2026]
`lca_components` and `lca_suppliers` are reusable libraries scoped like `client_factors`: a row with
`client_id` set is that client's; `client_id` NULL is a shared/global entry. Archive lifecycle, no hard
delete. Console migration `0045_lca_core`. *Source: `MODEL_FIDELITY_JOB_FAMILIES.md` §2, §6.*

### NZC-054 — LCA inventory is flat [Confirmed 1 Sep 2026]
`lca_line_items` are a **flat list per EN 15804 module** (A1–D), not a bill-of-materials tree. A multi-leg
transport journey is `lca_transport_legs` — an ordered, geocoded child of a transport-module line — with
the parent line caching the sum of its legs. Scenarios apply as multipliers over material categories /
components, never by editing the baseline inventory. Console migrations `0046`/`0047`. *Source:
`MODEL_FIDELITY_JOB_FAMILIES.md` §2, §6.*

### NZC-055 — Family review spine [Confirmed 1 Sep 2026]
A family's atomic reviewed unit — an **LCA assessment**, a **training course run** — is versioned with an
`expectedVersion` optimistic-concurrency guard, carries `provenance` / `lineage`, and its `review_status`
is **bound to a reviewed version** (`review_status='pending'` iff `reviewed_version IS NULL`), not the live
models' free-text enums. Family reports are assembled from a **content-addressed reviewed snapshot**, the
same discipline as a CRP report. Console migrations `0046`/`0048` (and `0050` for consultancy). *Source:
`MODEL_FIDELITY_JOB_FAMILIES.md` §3, §6.*

### NZC-056 — CRP↔Training via entitlements; shared factors; light consultancy [Confirmed 1 Sep 2026]
The **only** link between a CRP job and a training job is a `training_entitlements` row. Free training
places **originate from the quote / commercial terms** (quote → CRP job); a **manual CRP grant is the
secondary path**; both write an entitlement row whose status runs **available → reserved → consumed**
through a row-locked, status-guarded function (same construction as the job-number allocator) — a place
can't be double-consumed, and there is **no hard FK** from `training_bookings` to CRP jobs. LCA line-item
factor mapping uses the shared `emission_factors` / `client_factors` + the provenance signature — no
parallel `factor_lookup` / `lca_factor_*` tables. Consultancy stays light — **no time-tracking engine**,
just a versioned `job_consultancy_details` row (hours budget/used pair) plus a `consultancy_deliverables`
checklist. Console migrations `0049` (+ `0050` consultancy). *Source: `MODEL_FIDELITY_JOB_FAMILIES.md`
§4, §5, §6.*

### NZC-057 — Four-stage CRP lifecycle [Confirmed 4 Sep 2026]
`crp` workflow stages become **Setup → Data entry → Review & QA → Report & publish**. **Factor mapping is
retired as a stage**: factor selection happens **inline at capture** (activity smart-search / DVLA lookup
auto-matches, the user accepts). A row that still has no factor is a **"Needs attention" exception within
Data entry**, not a stage everyone walks through. `packages/contracts/src/commands.ts` `jobWorkflowStages.crp`
drives `isAllowedJobStageTransition` (adjacent-only) and `WorkflowStageControl`, so both follow the array.
**CRP-only** — `pcf` keeps its "Factor mapping" stage. Existing CRP jobs at `workflow_stage = "Factor mapping"`
migrate in the same PR: **→ "Data entry"** if any enabled row lacks a factor, else **→ "Review & QA"**, logged
in the stage-transition / audit trail as "stage retired (NZC-057)". **No flag** — the contract array plus
the one-way stage migration have no clean seam; landed atomically (DA2, PR #85). Migration `0053`.
*Source: `docs/_handoff_DATA_ASSURANCE_brief.md` §2.1; prototype `docs/prototypes/review_qa_v1.html`.*

### NZC-058 — Lean capture + drawer refine [Confirmed 4 Sep 2026]
The entry form captures **core fields only** — matched type (from registration) or activity, quantity + unit,
site-context, save. The factor is auto-set from the matched activity / lookup and shown **read-only**, not a
required pick. Factor override, quality tier, data confidence, evidence notes, supporting docs, reasoned
override and apportionment move to the **row's right-hand detail drawer** for post-save editing. The CRM
capture model thereby matches the portal's constrained one (`buildEmissionEntryFields`
`apps/console/app/jobs/emissionEntryModel.ts`). Flag `entry-lean-capture`.
*Source: `docs/_handoff_DATA_ASSURANCE_brief.md` §2.2.*

### NZC-059 — Review & QA is the Data-Assurance stage [Confirmed 4 Sep 2026]
The aggregate **Outputs tables** (five-year trend, by scope, by site, audit, intensity) **are** the QA
surface, in the same stage as row-level independent approval, under **one governed sign-off** that freezes
the content-addressed reviewed snapshot the Report track (NZC-051) consumes. The **baseline year** is always
shown with a **BL pill**; the trend shows **baseline + current + prior three reporting years**; **"% vs BL"**
(current ÷ baseline − 1) is a dedicated column. Assurance is a **right-hand overlay drawer** (the shared
scope-row detail drawer) so the trend table keeps **full page width**; a "🛡 Data assurance · N" tab reopens
it. Sign-off is **blocked while any gap is open** and while any enabled row is unapproved. Flag `data-assurance`.
*Source: `docs/_handoff_DATA_ASSURANCE_brief.md` §3.*

### NZC-060 — Data-integrity gap engine [Confirmed 4 Sep 2026]
Before sign-off the dataset must clear **four flag types**: (1) **YoY movement** — current vs the trend
outside the NZC-018 `[0.5×, 2×]` band (generalise `apps/console/app/jobs/yoyVariance.ts` from a single prior
to baseline + multi-year); (2) **completeness** — a category or site with prior-year data and none in the
current year; (3) **zero / blank** — a value expected (factor set) but 0 or missing quantity; (4)
**unmapped / uncalculated** — a row with no factor or no calculation. Each gap is **fixed** (edit the row →
re-evaluate) or **resolved-with-reason** (free-text reason stored on the row's provenance / lineage,
who + when). A resolved flag no longer blocks sign-off but stays visible (resolved state + reason) in the
audit trail. **A "% vs BL" reduction driven by an *unresolved* flag renders neutral grey** until the gap is
resolved, so an unverified data hole cannot read as a genuine reduction (the prototype's green is changed).
*Source: `docs/_handoff_DATA_ASSURANCE_brief.md` §3.*

### NZC-061 — Entry unit set [Confirmed 4 Sep 2026]
`mi` and passenger-distance units (`passenger.km`, `passenger.mi`) are added to the **per-row entry unit
list**, which omitted them (vehicles / commuting could not be entered in miles). Bulk paths
(`vehicleBulk.ts`, `commutingBulk.ts`) already carry `mi`. Delivered as DA5 (`entryUnitsForCategory`,
`apps/console/app/jobs/emissionEntryModel.ts`, PR #82) — standalone, no flag.
*Source: `docs/_handoff_DATA_ASSURANCE_brief.md` §2.3.*

### NZC-062 — Add rows from template [Confirmed 4 Sep 2026]
A fast, forgiving fuzzy search across the **whole job factor library** (every selected dataset + client
factor, every scope/category) — reuses `listJobFactorOptions`, extended with a derived
`categories: {scope, scopeCode, label}[]` per factor (its `scopes` resolved through the existing
`crpScopeCategoryLabel`, no new storage). This is the **unscoped power-user path**, alongside — not
replacing — the per-category smart-search already in the accordion's "+ Add entry" form. A result is shown
as `factor label · scope · category · unit · dataset`; picking one creates a fresh **enabled** row via the
existing `scope.row.create` (unforked), stamping the factor, scope, category and the selected site
(All sites → Unallocated, changeable on the row after), quantity empty, `pending`. The search stays open
after each pick (multi-add). Sits directly under the Data-entry stage's site selector, above the
scope→category cards. Flag `data-entry-fast-add`.
*Source: Francis, 4 Sep 2026 — "the two fast row-adding facilities the live site has."*

### NZC-063 — Reuse Previous Year Rows [Confirmed 4 Sep 2026]
Previous-year rollforward **generalised from the spend-only register** (`job_emission_sources`,
`rolled_forward_from_source_id`, NZC-030) **to every canonical row type**, by reading and writing
`job_scope_rows` directly — so a plain manually-added row rolls forward exactly like a
spend/vehicle/commuting-synced one. New self-referencing `job_scope_rows.rolled_forward_from_row_id`
(migration `0055`), mirroring the register's own `rolled_forward_from_source_id` pattern (one rolled-forward
copy per origin per job). The consultant **picks specific prior-year rows** (select-all / per-row — not an
automatic "roll everything forward"); each carries the same lineage the spend mechanism already surfaces —
factor-version-moved, dataset-not-in-selection, already-rolled-forward — computed the same way. On confirm,
the chosen rows are copied forward with factor + hierarchy + site intact, quantity empty, `pending`,
re-pinning the prior dataset selection (same NZC-030 continuity pattern) so the pinned factor stays
resolvable. Presented as a panel beside the template search. Flag `data-entry-fast-add` (shared with NZC-062
— split later only if the two need independent rollout).
*Source: Francis, 4 Sep 2026.*

### NZC-064 — Client record parity: wizard to add, tabs to edit [Confirmed 9 Sep 2026]
The redesign's client record carried only five fields (name, sector, location, owner, status) and had **no
edit path at all** — `client.create` was the only client-identity command. The live CRM's five tabs are
carried forward onto `clients` (migration `0060`, additive and nullable): **Details** firmographics
(portfolio, client manager, website, SIC, company registration, HQ, financial year end, data reporting
frequency, currency, logo, description, referral, and the primary contact that was previously written as
three permanently-empty strings); **Targets** — the net-zero trajectory reporting and portal dashboards read
(`WORKFLOWS.md` §2): net-zero year/%, per-scope interim year/%. *(Amended 10 Sep 2026: the baseline
period and historical baseline S1/S2/S3 + total are no longer client fields — see NZC-065. The Targets tab
edits the trajectory and initiates a re-baseline; it does not hold the baseline. Targets pin to the baseline
record they were set against — NZC-068.)*; **Address** — registered/trading and billing; **Compliance** — parent/group, group structure,
reporting frameworks, certifications, primary Scope 3 categories.

**Wizard to add, tabs to edit.** `/clients/new` is a four-step wizard (Identity → Targets → Address →
Compliance) so a new client does not land with everything blank the way the old inline form left it; only
identity is required, later steps can be deferred. `/clients/[id]/edit` is the five-tab record, matching what
consultants already know from live. Both surfaces render the *same* field-group components, so they cannot
drift.

**One atomic versioned command, not per-tab commands.** Saving from any tab sends the whole record through
`client.update` with `expectedVersion`, bumping the single `clients.version` — one audit event per save, and a
concurrent edit conflicts rather than being half-applied across four commands. Compliance selections draw
**primary Scope 3 categories from the canonical `emissionCategoryTaxonomy`**, not a parallel list, per "one
term one meaning"; they are advisory grounding for narrative and never derive a figure.

**Sites stay job-scoped.** A site is created in the job workspace where it is first used (existing
`site.create`, keyed on `jobId`); the client's Sites tab is a **read-only roll-up**. This diverges from live —
which owns sites on the client with geocode, registered-office and effective-dated vacate — and defers those,
so scope-row site FKs are untouched. Revisit if mid-period site closure becomes reporting-relevant.
*Source: Francis, 9 Sep 2026 — reviewing client add/edit against the live system.*

### NZC-065 — The baseline is a dated record, not fields on the client [Confirmed 10 Sep 2026]
NZC-064's Targets tab carries baseline period + historical S1/S2/S3 + total as **mutable fields on
`clients`** (migration `0060`). That is the live platform's model — `clients.benchmark_*`, overwritten in
place — with the split across four storage locations removed but the overwrite retained. `clients.version`
records *that* a save happened, not *what the baseline was before it*, so re-baselining still retroactively
restates every report that client has ever had, and a baseline period later than a report's own reporting
period is still possible by construction (the J000699 failure).

Replaced by **`client_baselines`**: client, period start/end, **either** `baseline_job_id` **or** typed
scope figures (both first-class — some clients' baselines predate the platform, which is what live's cached
`benchmark_*_tco2e` columns are genuinely for), `kind` (`initial` | `rebaseline` | `recalculation` — GHG
Protocol treats base-year *recalculation* after a structural change as a different act from choosing a new
base year, with different disclosure obligations), `source` (`declared` | `migrated_unverified`), reason,
`set_by`, `set_at`, `effective_from` (the first reporting period the record governs, distinct from when it
was entered), `superseded_at`. Plus `clients.baseline_significance_threshold_pct` — a base-year
recalculation policy has to state a threshold and there is nowhere to record one today.

The Targets tab becomes **re-baseline**: pick the new period, give a reason and a `kind`, and it writes a new
record superseding the old one. Old reports keep pointing at the old one. **Supersedes the baseline fields of
NZC-064 only**; Details, Address and Compliance stand unchanged, as does wizard-to-add / tabs-to-edit and the
single atomic `client.update`.
*Source: Francis, 10 Sep 2026 — re-baselining raised while fixing J000699 (Silent Sounds). See
`MODEL_FIDELITY_BASELINE.md` §2, and `RE_BASELINING_DESIGN.md` in `nzi_pro_v7-POSTGRES`.*

### NZC-066 — Issued reports stamp the baseline they were issued against [Confirmed 10 Sep 2026]
A dated record resolved at render time is **not** reproducibility — it is a better thing to resolve against.
Correct a mis-entered `client_baselines` row in 2027 and every historical report that resolves through it
moves again.

On issue, a report **stamps** its baseline onto the job: `baseline_id` plus the figures actually used and
`resolved_at`. Reissuing replays the snapshot and is identical regardless of what has happened to the client
record since. A report not yet issued resolves live, as now. NZC-059's **"% vs BL"** reads the stamp for an
issued report and resolves live only for a draft — so a Targets-tab save can no longer silently restate
historical percentages in the trend table.

`client_baselines` is the **policy** record; the stamp is the **reproducibility**. They are two mechanisms,
both needed. This also gives the audit trail a base-year recalculation policy requires: what the base year
was, when it changed, why, and what each issued report was measured against.

**Addendum — the stamp never gates the issued document (11 Sep 2026, Francis).** A published
report and its PDF stay retrievable whatever the provenance stamp says, including when there is none.
A snapshot issued before stamping, and one whose stamp was **backfilled**, both serve in full: the
figures come from the frozen payload, not from the stamp. A backfill marks what it writes
`source: "migrated_unverified"` — shown as context, never as assurance, and never as a reason to
withhold. The one thing that still refuses retrieval is an **evidence-hash mismatch** between a report
version and its snapshot, which says the two disagree about the figures themselves.

*Source: as NZC-065. See `MODEL_FIDELITY_BASELINE.md` §4.*

### NZC-067 — One baseline resolver; never look earlier than the baseline in force [Confirmed 10 Sep 2026]
The live platform has **eleven** independent implementations of "what is the baseline" — eight derivations of
which *year*, four of them the same rule written out separately, plus three in the pathway charts; and four
separate resolutions of which *job or figures*, two of which handle archived jobs differently. Two pathway
charts on the same live screen can start in different years for the same client. One fallback path resolves
to a hard-coded `2023`. `MODEL_FIDELITY_BASELINE.md` §1 has the table.

One function: `resolveBaseline(clientId, periodStart, periodEnd)` → period, figures, `source`, and whether
the job **is** its own baseline (a job that is the baseline has nothing earlier to compare against — no
baseline column and no prior-year column). The rule **never look earlier than the baseline in force** lives
in it and nowhere else. Sole consumer for the NZC-059 trend table and BL pill, the pathway charts, NZC-060's
gap engine (flag type 1 generalises YoY variance "to baseline + multi-year") and the portal. The frontend
receives the resolved baseline **in the payload** rather than re-deriving it, which is how live acquired
three of its eleven.

The resolver **declines to compare** against a `migrated_unverified` record rather than silently treating it
as a base year. It also adopts live's reporting-year eligibility rule (10 Sep): a job represents a year only
if its reporting period is **300–400 days**; among eligible jobs, latest `reporting_period_end` then highest
`job_id`; ineligible jobs are excluded and a client-year with no eligible job produces **no point**. Live
found stub jobs of 30–63 days and multi-year jobs of 452–790 days standing in for reporting years — without
this rule the five-year trend plots a 790-day total as one year.
*Source: as NZC-065. See `MODEL_FIDELITY_BASELINE.md` §1 and §3.*

### NZC-068 — Targets pin to their baseline; re-basing is a governed event [Confirmed 10 Sep 2026]
Targets are stored as **bare percentages with no reference to a baseline** (live's
`net_zero_target_reduction_pct`, `interim_s1/2/3_pct`, `target_s1/2/3_pct`, carried into NZC-064's Targets
tab). A percentage reduction is meaningless without the baseline it reduces from, so re-baselining silently
redefines whether every client is on track — a client at -22% against a 2019 baseline may be at +4% against
a 2026 one, with no record that anything changed.

**Decision: PIN, with a governed recalculation event.** The Targets-tab baseline — and the "% vs baseline"
it drives — is **pinned to the assured figures at baseline sign-off**. It does **not** move automatically
when factors are superseded, a dataset is refreshed, or a year is recalculated: the same freeze discipline
already applied to reviewed snapshots and cited factors.

Re-basing happens **only** through an explicit **recalculate baseline** command:
- a **reason is required**;
- the **prior baseline is retained** for history, never overwritten in place;
- the act is **audit-logged**.

This matches **GHG Protocol / SBTi base-year recalculation policy** practice, where recalculating the base
year after a structural change is a disclosable act with a stated reason and threshold, not a silent edit.
Pinning is the default state and recalculation the deliberate, evidenced exception, so a stated target always
describes the baseline it was set against, and any change to that relationship is on the record.

Unblocks the Targets tab in `0060`. **Implementation depends on NZC-065** — targets pin to a
`client_baselines` record, which does not exist until that decision is confirmed and built. Same answer as
open question 1 in `RE_BASELINING_DESIGN.md` on the live platform: answer once, apply to both.
*Source: Francis, 10 Sep 2026.*

### NZC-069 — Commercial ledger as source of record; Xero as projection [Held 11 Sep 2026]
**Held — to be revisited in a dedicated quotes/invoices exercise. Not confirmed, and not for merge.**

Proposed: the console's quotes / invoices / credit notes are the source of record and Xero is a downstream
projection and payment-reconciliation source only. An implementation (migration `0061`, since renumbered `0065`,
`commercial.ts`, `xeroSync.ts`, the client Financials panel) landed on `main` in 10707af alongside the
site and provenance work without sign-off, and reported a hard-coded "Xero connected" status. It has been
split out to its own branch (`feat/commercial-ledger`) for separate review; Xero status there is derived
from the real integration state and reads "Not connected" when there is none. It is parked as PR #140 and
does not merge to `main` until the quotes/invoices exercise confirms this decision and the feature has its own
review (it is where the earlier build break and failing migration test came from).
*Source: Francis, 11 Sep 2026 — corrective pass on 10707af; held the same day.*

### NZC-070 — Sites are effective-dated; the boundary follows the reporting period [Confirmed 11 Sep 2026]
A site has an optional **in-service-from** date and an optional **vacated-effective** date, and is never
hard-deleted. `vacated_effective` is the **first day out of service**. `in_service_from` **NULL** is an open
lower bound — "in service from before records" — and is what every pre-existing site carries (migration
`0063` undoes `0062`'s default of the migration date; never a guessed job date). A site created from a job
defaults to that job's reporting-period start; a site created from the client workspace states its date.

**The boundary is resolved against the job's reporting period** — the financial year stored as
`job_emissions_config.reporting_from`/`reporting_to` — not 1 Jan–31 Dec. The integer `reporting_year` is a
label only: a new job labelled *Y* for a client whose financial year ends in month *M* runs from the first
day of month *M+1* of *Y* to the last day of month *M* of *Y+1* (a December year end gives the calendar
year), so FY24 with a March year end is 01/04/2024–31/03/2025. Existing jobs keep their stored period —
it is never re-guessed. A site is in the boundary for a period when
`(in_service_from IS NULL OR in_service_from <= period_end) AND (vacated_effective IS NULL OR vacated_effective > period_start)`,
so a site vacated effective 01/04/2025 is in FY24 (to 31/03/2025) and out of FY25.

**One resolver** (`resolveSiteBoundary`, `@nzi/contracts`) is the sole consumer for the NZC-059 trend, the
NZC-060 gap engine, snapshot issue, report roll-ups, charts and the NZC-071 per-m² denominator, so the live
trend and a reviewed snapshot cannot disagree. A scope row at a site **outside** the boundary is excluded from
the figures and raised as a fifth gap type, **out of boundary** — never dropped silently.

**Registered office:** at most one per client (enforced by a partial unique index); a vacated site cannot be
the registered office, and vacating the registered office is blocked until it is reassigned. **Status** is
derived from today against the dates — *Planned* (future start), *In service* (with "vacates dd/mm/yyyy" for
a future vacate), *Vacated* — never stored.

Amends NZC-064's "sites stay job-scoped / read-only roll-up": sites are still created where first used and
scope-row site FKs are untouched, but the client workspace now manages site lifecycle, which is exactly the
"mid-period site closure becomes reporting-relevant" trigger NZC-064 named.
*Source: Francis, 11 Sep 2026 — corrective pass on the site effective-dating brief.*

### NZC-071 — Site floor area is effective-dated; it is the per-m² denominator [Confirmed 11 Sep 2026]
The per-m² intensity denominator was a single number typed onto the job's intensity target, so it could not
follow the site boundary: vacate a site and the emissions fall while the floor area does not. Floor area is
now an **effective-dated, append-only** record per site (`client_site_floor_areas`: `floor_area_m2`,
`effective_from`, who/when); a site's floor area for a period is the record in force at the period end.

The **per-m² denominator = the sum of the in-boundary sites' floor area** for the job's reporting period
(NZC-070). If **any** in-boundary site has no floor area in force, per-m² intensity is **unavailable** —
never a partial sum and never zero. The typed `reportingDenominator` is deprecated for the floor-area metric
(turnover and headcount still use it).
*Source: Francis, 11 Sep 2026.*

*(NZC-008 resolved 24 Aug 2026: `job_scope_rows` is canonical; `crp_scope_entries` is legacy migration
input. NZC-020 resolved 24 Aug 2026: synthetic by default, with a vetted anonymised subset permitted only
for restricted migration/compatibility testing. NZC-021 resolved 24 Aug 2026: rebuild reporting natively
in the isolated platform. NZC-022 resolved 24 Aug 2026: explicit roles and named permissions, with the
detailed matrix refined per workspace — and the matrix itself resolved 11 Sep 2026 as PERMISSION_MATRIX.md. NZC-025 resolved 24 Aug 2026: official zero-padded `J` numbers over
one shared counter, with family stored separately; guaranteed gapless via assign-on-commit. NZC-026–029
confirmed 24 Aug 2026: one derived, provenance-bearing SVG chart system across console, PDF and portal,
with content identity and manifest validation as a hard publication gate. NZC-032–035 confirmed 28 Aug 2026: reporting-period-aligned monthly granularity with copy-to-all; scope-row hierarchy + report label; override-with-reason in the write path; and one shared data-entry framework across the portal and CRP. NZC-018 (spend categorisation) and the NZC-030 rollforward re-pin were confirmed the same day. NZC-036–037 confirmed 28 Aug 2026: a single bulk-upload standard (hardened Excel + in-browser paste grid + remembered CSV mapper) over one canonical download identity, and Company Vehicles replacing the Asset Register. NZC-038 confirmed 28 Aug 2026: a single stage-as-section workspace design language — named, numbered, colour-matched, collapsible sections with completed ones sinking to the bottom — applied site-wide including the client portal.)*

The **Proposed** items (NZC-006, 007, 009, 011–019, 023) are recommendations ready to be confirmed as a
batch once reviewed. NZC-024 (job-family module separation) was confirmed 1 Sep 2026; NZC-026–029 (the
graphics redesign) were confirmed 24 Aug 2026 — both direct responses to the two requirements raised on
24 Aug 2026.
### NZC-072 — Forward targets are their own record, and the pathway derives from them [Confirmed 12 Sep 2026]
The **baseline** is the past anchor: tonnes, measured, restated only through a governed re-baseline
(NZC-065/068). **Targets** are the forward commitment: a year and a percentage reduction *against that
benchmark*. Live keeps both on the client row, which is why a base-year change silently restated what a
client had committed to. They are separated here:

- `client_targets` holds near-term, net-zero and per-scope (S1/S2/S3) year + %, **versioned and
  append-only** — a change writes the next version and every one is audited.
- The **benchmark is read, never typed**: it comes from the baseline in force and is **stamped** onto the
  target version, so a target always says what it was measured against. `benchmark_year` is therefore not
  an editable field.
- The **reduction pathway** and the **target gap** are both computed from that model — the benchmark and
  `benchmark × (1 − pct)` at each committed year — so the chart and the gap cannot tell different stories.
  A 90% commitment ends at its 10% residual, not at zero.
- A client with nothing set has **no targets**, not zeros: the card says so and no line is drawn.
- **A re-baseline holds the targets** (NZC-068). They stay in force against the benchmark they were set
  against and are flagged as standing on a superseded one. Moving them is `client.targets.set` with an
  explicit restatement and a reason, audited as `client_targets_restated`.
- Editing targets needs `target.edit` (PERMISSION_MATRIX.md); the baseline still moves only through
  re-baseline.

*Source: Francis, 12 Sep 2026 — the forward target model brief; design reference
`docs/prototypes/client_workspace_v10.html`.*

### NZC-073 — Training carries its own capabilities [Confirmed 13 Sep 2026]
Training is a **module** in exactly the sense Actions and SRS Readiness are, and both of those
already hold their own capability. Running it off the generic `job.manage` was the deviation, and
it had two consequences worth naming: anyone who could manage a job could issue **NZI-branded
verifiable certificates**, and moving a training place's expiry sat under `finance.manage`, so
Finance could extend a place the delivering consultant could not.

Two capabilities are added, held by **Admin and Consultant**, mirroring `actions.manage` /
`srs.manage`:

- **`training.manage`** — bookings, attendance, run stage transitions, certificate issuance.
- **`training.entitlement.manage`** — moving a place's expiry off its job-end default. Extending
  an already-granted place is an **operational concession, not a commercial re-sale**, so it
  belongs with the delivering team; Finance keeps read visibility through `finance.view`. It is
  treated like `baseline.rebaseline`: a **reason is required**, the change is audited, and it
  clears the `default_from_job_end` flag so "moved" stays distinguishable from "default".

Two things deliberately do **not** move. **Run review stays `snapshot.review`** — the consultant
who delivers a course and issues its certificates must not also approve the reviewed run
snapshot, the same separation of duties that governs every other reviewed unit. And **certificate
issuance stays policy-gated on top of the capability**: attendance decides and consent holds. The
capability says who may run the command; the policy still decides the outcome.

This **supersedes the interim reuse** of `job.manage` (bookings/attendance/stage/certificates) and
`finance.manage` (expiry) while the training backend was first wired up — no release shipped with
those gates. The matrix moves to **version 2** (migration `0073`), and the capability pattern is
widened to allow more than one dot, which `training.entitlement.manage` needs.
*Source: Francis, 13 Sep 2026 — Training family brief; `docs/PERMISSION_MATRIX.md`.*

### NZC-076 — Strategy deadline reminders are emailed, and staging cannot send them [Confirmed 14 Sep 2026]

**What shipped.** Email reminders for approaching and overdue reduction-strategy target dates
(PR #165, migration `0083`), completing the notifications family: in-app and portal signals
derived at read time (#164), and email sent by a worker.

**Transport: Office 365 SMTP, matching live.** The worker reads `SMTP_HOST`, `SMTP_PORT`,
`SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` and `SMTP_TLS` from the environment — the same contract
`nzi-insights-pro-api-live` already carries, with each service supplying its own values. None of
them is in the repository, and a configuration error names the missing variable without echoing
any value.

**A separate worker, not the web service.** `nzi-console-reminders` is its own Render `worker`
service, draining `transactional_outbox` on a clock (`NZI_REMINDER_TICK_SECONDS`, 900 s). A tick
driven by web traffic fires whenever someone happens to be looking, which is neither a schedule
nor idempotent. It is also the outbox's **first drainer** since `0001`: every command has written
a row there and nothing had ever read one. That standing backlog is cleared as `skipped` — a
state added for the purpose, because marking it `sent` would record deliveries that never
happened — and none of it can become email, since no backlog topic has a mail handler.

**Idempotent by claim-before-send.** A `strategy_automation_log` row is claimed *before* a send is
attempted, never written after one succeeds, so a crash mid-send cannot lose the fact that a send
was owed. The unique key is (strategy, kind, target date, recipient): a re-run of the clock never
double-sends, a moved date earns a new reminder, and a transient SMTP failure retries without
duplicating a delivered message. A queued reminder is re-derived against live state before it is
sent, so a strategy finished since the scan is not chased.

**Staging is suppress-and-log, and it fails closed.** On `NZI_DATABASE_BOUNDARY=isolated-non-production`
the worker composes each reminder, records it in full with `state='suppressed'`, and puts nothing on
the wire. The worker **refuses to boot without that boundary**: its start-up guard is
`validateDatabaseBoundary`, which throws on any other token and on `APP_ENV=production`. Real sending
additionally needs `NEXT_PUBLIC_APP_ENV=production` and `NZI_MAIL_MODE=send`, and every one of the
three defaults to silence.

**Consent holds.** `client_contacts.email_consent` (`unknown` | `granted` | `declined`) defaults to
`unknown`, following the training model: an absent decision is not permission. Only `granted` is
written to.

**Staging verification (14 Sep 2026)** covered the worker lifecycle and the outbox drain only: the
worker boots, refuses any boundary but `isolated-non-production`, self-suppresses (transport:
suppressed), and drained the pre-existing outbox backlog as skipped (42 skipped / 0 sent / 0 failed).
The reminder-generation path — scan due strategies → resolve contact → consent check → suppress/send
→ log — was NOT exercised on staging, because there are no client strategies on staging yet; that
path is proven by the real-Postgres CI suite, not by a staging run. `strategy_automation_log` is empty
because no reminder has run, not because of consent state.

**Two production gates, both intentionally open.**

- **(a) Consent capture.** Nothing in the product sets `email_consent` yet, so no contact can be
  written to. Production needs an audited way to record it — a reasoned, attributable change with
  a history, not a direct database edit.
- **(b) A live worker standup** against the live database boundary with real SMTP, as a separate
  reviewed deploy. This is **not configuration alone**: the start-up guard that makes staging fail
  closed also refuses the live boundary and `APP_ENV=production`, so the send path is unreachable
  from the current code by design. Standing the worker up live needs a reviewed change to that
  guard as well as the deploy.

*Source: Francis, 14 Sep 2026 — transport (Office 365 SMTP) and background-worker decisions; staging
verification of #165.*

### NZC-075 — Actions become Reduction Strategies, and levers become a categorisation [Confirmed 14 Sep 2026]

**The name.** "Reduction Strategies", for ISO 14060 alignment — and never bare "Strategies",
because `Strategy` is already one of the four SRS pillars and one-term-one-meaning is locked.
The SRS pillar is untouched. The entity is *a reduction strategy*; the area is *Reduction
Strategies*.

**The model.** `0075` shipped a flat catalogue whose rows were called levers, each with a
free-text `category`. Both were wrong in the same way. A lever is a **theme** — energy,
buildings, transport, procurement — that several strategies share, and a strategy can belong
to more than one of them: installing solar is energy *and* buildings. A text column cannot
express that, and it cannot be filtered, ordered or given an icon. So the concepts separate:
`levers` (Admin-managed), `reduction_strategies` (the shared library), and `strategy_levers`
joining them many-to-many. The plan is grouped by lever, and a strategy allocated to two
levers appears under both — that is what the categorisation means, and hiding it from one of
its themes would make the grouping lie.

**Control level stays its own axis.** "Which theme is this" and "how much of the outcome does
the client control" are different questions, and a single field cannot answer both. Control
level remains single-valued: direct control / supply chain / influence.

**The capability** moves `actions.manage` → `strategy.manage` at **matrix version 3**, held by
Admin and Consultant exactly as before. A new version, never an edit: a principal resolved
against version 1 or 2 keeps meaning what it meant when it was resolved. The library stays on
`admin.lookups` — a consultant builds a plan from it but does not redefine it while doing so.

This **supersedes the model in `0075`** rather than sitting beside it, and supersedes
`docs/_handoff_ACTION_LEVER_LIBRARY_brief.md`.

*Source: Francis, 14 Sep 2026 — Reduction Strategies brief.*

### NZC-074 — A trainee is a person, and their record is portable [Confirmed 13 Sep 2026]
The load-bearing decision of the training family, and the one everything else in it follows from.

**Identity is person-centric.** A trainee is one record per individual, not a contact hanging off a
client. The sign-in identity is their **personal** email — changeable, normalised, unique, and
deliberately never a key. History aggregates per person, across every employer they have had.
Making the trainee a client's contact would have been simpler and wrong: it would mean a person's
certificates belonged to whoever employed them at the time, and disappeared when they moved.

**Employer and funding are frozen at booking.** Each booking records who arranged the training and
how it was paid for, as at that moment, and neither is ever re-read from the person's current
employer. Updating where you work changes where you work — it does not rewrite who paid for a
course in 2024. This is also what makes the two portals safe to build from the same rows: the
client's view filters on the frozen employer, so it shows its own people and never a person's
history elsewhere.

**Places are booked by consultant/CRM only.** There is no self-serve booking from either portal.
A place is a commercial instrument with an expiry and an atomic consume; putting a "book now"
button on it would mean a client could spend an entitlement without anyone scheduling the delivery
that has to follow. The client portal instead shows what is unused and when it expires, and says
to talk to their consultant.

**Certificates are publicly verifiable.** A certificate is worth more if a future employer can
confirm it without an account, so `/verify/<code>` is public. That makes it the one tenant-crossing
read on the platform, which is why it goes through `verify_training_certificate` — a SECURITY
DEFINER function whose `RETURNS TABLE` *is* the contract: name, course, date, attendance, issuer,
standing. It cannot return an email, an employer, or anything else the person has studied, because
no caller can widen it. The verify code is separate from the certificate number (which is NZI's own
reference and guessable by design) and carries enough entropy that certificates cannot be
enumerated. A **revoked certificate still verifies** and says it was withdrawn — a copy in
circulation should be recognisable for what it is.

**Changing the sign-in email requires re-verification**, and the old address stays the login until
the new one is confirmed: a mistyped address locks nobody out, and a borrowed session cannot
quietly take an account over. Confirming revokes every session so the change lands everywhere at
once. The corollary Francis confirmed explicitly: once a person updates their personal details, a
**former employer loses visibility of them** — the client portal reads the employer frozen on each
booking, so the old employer keeps the training record it paid for and nothing of the person's
current identity.

*Source: Francis, 13 Sep 2026 — Training family brief, four decisions confirmed at the outset.*


### NZC-077 — Staging applies migrations on deploy; production refuses to deploy without them [Confirmed 15 Sep 2026]

**What happened.** #176 merged and auto-deploy shipped code reading the `0084`
`client_contact_consent_events` table, which had not been applied to the staging database.
`render.yaml` had no migration step — schema was applied out of band, by hand — so
`getClientWorkspace` threw and **every** client workspace returned 503. Two independent faults:
schema and code shipped apart, and a peripheral read cascaded into the core record.

**Staging auto-applies, before cutover.** A pre-deploy step runs the migration runner. Staging is
isolated, carries no real client data, and optimises for velocity; a gate that needed a human at
every deploy would be routed around within a week. The runner is safe to run unconditionally: it
is ledger-based and idempotent, applies pending files in order, refuses gaps and checksum
mismatches, and CI already proves each migration applies against a real Postgres.

**It fails closed, which is the part that matters.** Render runs the pre-deploy command after the
build and before cutover, and a non-zero exit aborts the whole deploy while the previous version
keeps serving. So a migration that cannot complete leaves the *old code* on the *old schema* —
consistent — rather than new code against a database that does not match it. (`preDeployCommand`
needs a paid instance type; `nzi-console` is on `starter`.)

**Production takes the opposite posture: a hard check, never an auto-apply.** Its pre-deploy runs
`migrate:status`, which is read-only and exits non-zero when anything is pending, so a release
against a stale schema **fails closed** instead of migrating on its own. A production schema change
stays a deliberate human act: applied through the runner in the live service's Render Shell, with
secrets left in the environment, confirmed clean, and only then deployed.

Why the asymmetry is not inconsistency: in both environments the deploy refuses to serve code
against a schema it does not match. They differ only in who is trusted to close the gap — staging
lets the runner do it, production requires a person.

**The live service is not touched by this decision.** The production posture is written down in
`DEPLOYMENT.md` and wired to the live service **at go-live**, as its own reviewed step.

**How it was actually implemented (16 Sep 2026).** The staging gate is set as the Render
**dashboard Pre-Deploy Command**, not through `render.yaml`: the staging service is not
Blueprint-managed, so Render never reads that file for it and the YAML line would have looked like
a gate while being inert. The decision is unchanged — a pre-deploy step runs the runner, fails
closed — only the surface it is configured on. The `render.yaml` line is kept as documentation and
as the carrier for a future Blueprint rebuild. It went in with `0085`, which it applied unattended
on #182; `0084` was the last migration this project applied by hand. Staging no longer needs the
apply-before-merge discipline; production still does, by design.

**The second fault is fixed separately.** An adjunct read must not be able to down the record it
sits beside — `DESIGN_CONVENTIONS` §12, and `getClientWorkspace` now degrades its adjunct reads to
honest "unavailable" states while essential reads still fail loudly. The gate stops schema drift;
the resilience rule stops the next surprise from costing the whole page.

### NZC-078 — A strategy carries an estimated reduction, and an estimate is never a measurement [Confirmed 15 Sep 2026]

**What shipped.** The first quantitative layer on Reduction Strategies (migration `0085`): a
consultant's expected annual reduction per strategy, rolled up into a **projected** trajectory and
drawn against the existing **target** pathway and the **measured** actuals. Staff console only.

**The rule that outranks the rest: a projection is a forward estimate.** It is built from
consultant judgement, never derived from an assured snapshot, and never rendered as the footprint.
A test asserts the module imports only the plan and the target model, and that no code path in it
reaches for a snapshot or a measurement; the chart encodes the distinction twice, by hue and by
dash, so "estimate" survives greyscale, print and colour-blindness. The three series answer three
different questions and the value is the distance between them — a projected line that merged into
the measured one would destroy the only comparison worth having.

**Basis: consultant estimate, optionally seeded from the catalogue.** Not modelled from activity
data, which would buy false precision for a much larger build. The library already carried
`modelled_tco2e_per_year` with a mandatory basis (`0075`), so a client estimate seeds from it and
records that it did — no library migration was needed.

**Expression: tCO₂e/yr or a percent, both resolved to tCO₂e/yr.** A percent resolves against that
scope's share of the **benchmark in force** — the same denominator the target pathway uses, which
is what makes bottom-up and top-down comparable rather than two numbers sharing an axis. The
resolved figure is **stored**, not recomputed on read, for the same reason targets stamp the
benchmark they were set against: a later re-baseline must not silently restate a number a
consultant agreed.

**Timing: steps in at the target date.** The full annual reduction applies from that date onward.
An **undated** strategy contributes nothing and is flagged — inventing a date would put a saving on
the chart nobody committed to a time for. A strategy with **no estimate** likewise contributes
nothing and says so: "not estimated" and "saves nothing" are different facts.

**Overlap: sum, and raise over-claim — never cap.** If a scope's projected reductions exceed that
scope's footprint, the scope and the contributing strategies are named. Silently clamping would
make an arithmetic error look like a plan that exactly eliminates a scope, which is the most
flattering possible reading of a mistake. The line is floored at zero so it stays drawable, and the
warning is what makes the floor visible.

**Permission: `strategy.manage`, reused.** Entering an estimate is managing the strategy, and that
capability is already held by exactly Admin and Consultant. The matrix stays at version 3.

**Staff console only this phase.** Report inclusion (freezing the projection into the composition at
issue, with client-facing estimate discipline), portal inclusion, and consultant-marked strategy
interactions for finer overlap accounting are later phases, each with their own review.

### NZC-079 — The Render dashboard is the source of truth for the staging services; `render.yaml` is documentation [Confirmed 16 Sep 2026]

**What was found.** `nzi-console` and `nzi-console-reminders` were created by hand, not from a
Blueprint, so Render never reads `render.yaml` for them. The file nonetheless claimed, at
`render.yaml:18–22`, to be "the single source of truth" for the redesign feature flags — while
`DEPLOYMENT.md`, `REDESIGN_ROLLOUT.md` and five acceptance documents already said the opposite, and
the same file described two of its own three flag variables as dashboard flips "for continuity
only". Surfaced by NZC-077, where the migration gate had to be set in the dashboard because the
YAML line would have been inert.

**Decision: the dashboard is the effective source of truth for these two services.** `render.yaml`
is documentation, and the carrier for a future Blueprint rebuild. A change to it does nothing to
the running build, and the file now says so where it previously claimed the reverse.

**But the file must still tell the truth.** Inert is not the same as free to be wrong: it is what
anyone reads to learn what staging is, and a stale value there is a false belief waiting to be
acted on. So it is reconciled to the running configuration and kept in step in the same PR as any
dashboard change (`docs/CONFIG_DRIFT_REPORT.md`).

**What the reconciliation found.** Of eighteen declared values, fifteen matched — including **every
feature flag**, so the failure mode this exercise was built to catch ("staging is not the build we
think it is") had not happened. Two auth variables had drifted, and one live variable was missing
from the file entirely:

- `NZI_AUTH_ENABLED` / `NZI_AUTH_REQUIRED` — declared `"false"`, live `true`, corroborated
  independently by `/api/health`. The file now records the live values, **and records that their
  intent is unconfirmed**: deliberate, or inherited from the recycled service this one was created
  on. Nothing live was changed on that evidence.
- `NEXT_PUBLIC_FEATURE_PORTAL` = `portal-analytics,portal-actions` — live and undeclared; now
  declared.

**The more interesting finding was not drift at all.** The portal reduction plan (#173) and the
portal readiness statement (#177) are behind **no feature flag**, unlike every other portal Phase 2
surface. Nothing is dark; but there is no way to turn either off without a revert, which is what a
flag exists to buy. Recorded as an open decision, not actioned here.

**Blueprint adoption is the recommended end state, and is deliberately not done.** Making
`render.yaml` authoritative would make this class of drift impossible, which is what the false
comment wished were true. It also risks duplicating live services, so it is its own migration with
its own review — not a side effect of a documentation pass.

**The legacy tail stays.** `MS_*`, `NZI_ENVIRONMENT`, `NZI_JWT_SECRET` and others sit in the
console's dashboard undeclared. None was removed: with auth now known to be enabled and required,
`NZI_JWT_SECRET` is plausibly load-bearing, and tidying a list is not a reason to risk it. Each key
needs its own check before deletion. **The worker has no such tail** — it holds exactly four keys.

**The worker's isolation was verified, not assumed.** Its dashboard carries `NODE_VERSION`,
`NZI_DATABASE_BOUNDARY`, `NZI_DEMO_ORGANISATION_ID` and `NZI_ISOLATED_DATABASE_URL` — and neither
`NZI_MAIL_MODE` nor any `SMTP_*` value. It therefore cannot put mail on the wire, by three
independent conditions rather than one, and with no transport to open even if all three were
defeated. The boundary token is checked first in `mailDelivery()`, so the worker's own startup line
— *"runs against the isolated non-production boundary"* — is that branch firing, and is itself
evidence the variable is set correctly. Two declared keys are unset (`NEXT_PUBLIC_APP_ENV`,
`NZI_REMINDER_TICK_SECONDS`); both fail safe and neither changes behaviour, the tick's code default
being the declared 900 s.

### NZC-080 — The two ungated portal surfaces get their rollout gates retrospectively [Confirmed 16 Sep 2026]

**What was found.** Reconciling config against the dashboard (NZC-079) asked whether the portal
reduction plan (#173) and the portal SRS readiness statement (#177) were merged but dark behind an
unset token. Tracing every `portalFeatureEnabled` call site gave a different answer: **neither was
gated at all.** Both rendered unconditionally from `PortalHome`, and neither component nor either
API route consulted a flag.

Nothing was dark, and nothing was harmed — both surfaces are read-only, tenant-scoped and were
merged deliberately. But `REDESIGN_ROLLOUT.md` requires new UI to sit behind a flag until its
acceptance pass, and every other portal Phase 2 surface does. These two left no way to withdraw
either short of a revert, which is the one thing a flag exists to provide.

**Decision: retrofit a token per surface** — `portal-plan` and `portal-readiness`, through the same
`portalFeatureEnabled` mechanism, registered in `REDESIGN_ROLLOUT.md` and declared in `render.yaml`.
One token each rather than one shared: they are separate surfaces, and withdrawing readiness should
not take the plan with it.

**No client-visible change.** Both tokens were set in the dashboard before the gate shipped, so the
surfaces resolve enabled on deploy. The gate restores a capability; it does not exercise it.

**The API routes stay ungated, deliberately.** No portal API route is flag-gated — the convention is
that flags gate UI. Inventing a stricter rule for these two alone would make them inconsistent with
every other portal surface for no stated reason. The data behind both is read-only and tenant-scoped
either way.

**The acceptance debt is not settled by this.** These are the two surfaces that reached staging
without the acceptance pass the rollout document requires. Having a gate is not the same as having
been accepted, and the backlog rows say so.

### NZC-081 — The knowledge library: NZI-wide, two-tier, and never written by the AI alone [Confirmed 16 Sep 2026]

**What shipped (0a).** The spine of the help system (`docs/_handoff_HELP_SYSTEM_design.md`): a governed
knowledge library with duplicate-safe capture, two-tier approval, and the capabilities that gate it.
Migrations `0086` (model) and `0087` (permission matrix v4). The drawer, tours and grounding
interface are 0b–0d and build on this.

**Scope: this is NZI's own knowledge, not client data.** The tables carry `organisation_id` — the
consultancy tenant, the same column every table uses — and **deliberately no `client_id`**. An
answer written while working on one client is meant to be found by everyone; a client column would
silently partition the library and defeat its purpose. The absence is load-bearing, so a test
asserts it structurally rather than trusting a reviewer to notice one arriving later.

**A draft is an entry, not a separate table.** A draft has the same shape as the thing it becomes.
A second table would duplicate every column, need its own versioning, and require a copy on
approval — which is exactly where the reviewed text and the approved text drift apart. One table,
one lifecycle: `draft → internal → public`.

**Three capabilities, not two.** `knowledge.capture` is held by **every role**: anyone who answers a
question should be able to offer it, and writing to the library is its own act rather than something
that rides an unrelated gate. `knowledge.approve` (Admin + Consultant) makes an entry live for staff
and citable by the help AI. `knowledge.publish` is **Admin only** — it is what makes something
client-facing and website-bound. A Consultant writes most of the knowledge and can approve it
internally but cannot put anything in front of a client, which is what gives the two tiers meaning.
(If Admin-only publishing becomes a bottleneck it widens to a named publisher set later.)

**Duplicate handling surfaces; it never decides.** Capture is idempotent — one open draft per person
per captured answer, enforced by a partial unique index rather than by the command remembering to
look. Before a draft is created, similar approved entries **and pending drafts** are surfaced so the
asker can open the existing answer, add their phrasing as an alias, or proceed with a draft flagged
for the approver. Hard uniqueness applies only to an approved entry's canonical key: two people
legitimately asking the same thing in one week must not collide, but two *approved* entries saying
the same thing must.

**Similarity is trigram today, and that is a deliberate v1.** `pg_trgm` is lexical: it catches
shared-word rephrasings and misses semantic ones — "is the report externally verified?" will not
match "what does reviewed not assured mean?". That is acceptable **because a person adjudicates**;
the mechanism ranks candidates for a human and merges nothing on its own. **Embedding-based
similarity is the known upgrade** for semantic duplicates, and lands naturally with the Phase 1
grounding work. It is a roadmap item, not a silent gap. `pg_trgm` is this schema's first extension
and is created explicitly, so an environment that cannot create it fails loudly rather than
degrading to exact matching that would look like dedup and do nothing.

**An edit to an approved entry does not take it offline.** The edit becomes a pending draft pointing
at the approved entry; the approved answer stays live and keeps grounding the AI until the revision
is approved, at which point it replaces the original and the revision closes. A correction in
progress must never remove the answer people are relying on.

**The integrity guarantee the rest of the help system rests on:** an AI-drafted answer enters as a
draft and nothing more. The AI proposes, a named person ratifies, and the library records which —
that is what makes a cited entry worth citing. It is also the whole write surface the AI will ever
have; it never mutates app data.

### NZC-082 — Tours are data, seen-state is per person, and one write sits outside the command layer [Confirmed 16 Sep 2026]

**What shipped (0c).** The declarative tour engine, per-user seen-state (migration `0088`), the
Guide tab that 0b stubbed, and one exemplar tour for the client workspace so the auto-run →
replay → remember loop is exercised by something real rather than by a fixture.

**Tours are content.** A tour is a list of anchors and words in `apps/console/app/help/tours.ts`;
the engine that renders them knows nothing about any page, and a test asserts it never names one.
Adding a page's tour is an edit to that file and a review of its wording — not a change to a
component. That is what makes "authored per page as each page is finished" practical.

**Seen-state is keyed on the tour *and its version*.** This is the part worth stating plainly: a
materially revised tour has no record for anyone, so it surfaces again for the people who saw the
old one. Keying on the tour alone would silently suppress a rewritten tour for exactly the users
who most need the new version — the ones already using the page. Bumping the version is therefore
an editorial act meaning "this changed enough to be worth showing again"; a typo fix does not
warrant one.

**It is per person, not per device — which is why it is in the database.** Per-viewer conveniences
in this app live in browser storage and should. This one cannot: someone taught the client
workspace on their laptop should not be taught it again on their tablet, and browser storage
clears. The reason is cross-device continuity, not governance.

**A dismissal and a completion are different facts.** Both stop the auto-run; only one is a
preference. They are stored separately so a future "show me the tours again" can tell them apart,
and once dismissed stays dismissed — replaying a tour you asked never to see again is not a request
to start being taught it.

**The exception: this is the one mutation in the app that is not a command.** Every other write is
permission-checked and audited — `PERMISSION_MATRIX.md` says no mutating path is exempt, and this
is the documented exception to that sentence. Recording that you were shown a tour is a person's
own UI state, the server-side equivalent of a remembered collapsed panel; an audit entry for it
would be noise in a log that exists to answer who changed a client's data, and a capability for it
would be a permission nobody could sensibly be refused.

The safety is structural instead: the user and organisation come from the **verified session**,
never from the request body, so the only row anyone can write is their own — and the route accepts
nothing that identifies a person. If that trade ever looks wrong, the fix is a capability held by
every role (as `knowledge.capture` is), not an unaudited write with a wider reach.

**The engine never acts for the user.** A step may say what to try; it never clicks it. A tour that
performed actions would be changing someone's data in order to explain their data.

**A step whose anchor is missing is skipped, not guessed at.** A spotlight on nothing — or on the
wrong element after a refactor — teaches something false, which is worse than a shorter tour.

### NZC-083 — Grounding: cited or silent, and the citation rule is a type [Confirmed 16 Sep 2026]

**What shipped (0d).** The retrieval, citation and abstention contract the help assistant will
answer from. **No model call and no generation** — Phase 1 adds that on top, Phase 2 adds
live-data tools behind the same contract. Read-side only; no migration.

**The citation rule is enforced by the type, not by discipline.** `GroundedCandidate.citation` is
required and non-optional, and the only constructor takes the citation as an argument — so a
candidate with nothing behind it is unrepresentable rather than merely discouraged. A test asserts
`citation?:` never appears. Discipline is what fails inside a prompt template at 2am; a type does
not.

**Abstention is a result, not an absence.** `groundingResult` returns `abstained` when nothing
clears the floor, and an empty grounded result is deliberately impossible — otherwise a caller
could loop over zero candidates and emit prose anyway. The wording is a statement about the
sources ("nothing in the approved knowledge answers this yet"), never about the asker.

**Retrieved content is data, not instructions.** Every retrieved string is wrapped as
`RetrievedText`, a tagged value rather than a bare string, so library text — and later a client's
own records — cannot be concatenated into a prompt as though it were the system's own voice.
Reading it back takes a named `retrievedText()` call, which makes every such place greppable and
reviewable. The tag is a **boundary, not a sanitiser**: it does not make hostile text safe, it
makes the moment of trusting it explicit. The boundary holds for approved entries too — "approved"
describes who ratified the answer, not what someone typed inside it.

**Only ratified knowledge grounds an answer.** Drafts and withdrawn entries are excluded. The
integrity argument for citing the library is that a person stood behind the answer; grounding on
drafts would let an unreviewed answer — including one the assistant proposed itself — return as
though it were established, closing exactly the loop two-tier approval opens.

**Product docs are declared and empty, on purpose.** The design names documentation as a source
and it will be one, but **there is no corpus to index yet**, so the source returns nothing and
says so in its label. The alternative — serving public-tier library entries as "docs" — was
rejected: those are already returned by the library source, so re-serving them would return one
answer under two citations and make a single source look like two corroborating ones. Manufactured
corroboration is a subtler version of the failure this whole design exists to prevent.

**A broken source is reported, never mistaken for an empty one.** "We could not read the library"
and "the library has nothing on this" are opposite claims; abstaining on the first would tell
someone their question is unanswered when it may well be answered, and would invite them to
capture a duplicate of an entry that already exists. A failed source abstains with a fault message
and suppresses the capture offer.

**The contract is source-agnostic by design.** A `GroundingSource` is an id, a label and a
`retrieve`. Phase 2's permission-checked read-model tools are a new implementation of that
interface, not a change to anything above it — and `live-data` citations already name the read
model that produced a figure, so an answer about a client's own data will be traceable to the same
resolver the screen used rather than to a second path that can quietly disagree.

### NZC-084 — Product docs are a distinct corpus, and one entry is never two citations [Confirmed 16 Sep 2026]

**Decision.** Product documentation is a **separate registered grounding source** with its own
corpus. It must **never** be re-served from public-tier knowledge-library entries, and no answer
may present one approved entry as two corroborating citations. A `GroundingSource` declares the
one citation kind it may `emit`, and `retrieveGrounding` drops — and reports — any candidate
citing a corpus that is not its source's own.

**Why this needs to be a rule and not just a rationale.** 0d stubbed docs as an empty registered
source precisely to avoid this, but "we happened not to do it" binds nobody. Populating the corpus
is future work, and the shortcut will look attractive at exactly that moment: public-tier entries
are already written, already approved, already client-safe. The rule has to outlive the decision
not to take it.

**The failure it prevents is the hard kind to see.** Corroboration is something a reader *counts*.
Two citations read as two sources independently agreeing, and a person — rightly — weighs an
answer more heavily for it. If both are the same library entry wearing different hats, that extra
confidence is manufactured out of nothing. Every individual citation is real and checkable, which
is why such an answer would pass review: there is no fabricated reference to spot. It is a subtler
failure than invention and it corrupts the one signal the whole grounded design asks people to
trust.

**Genuine agreement is not the same thing.** Where a real document and a library entry
independently say the same thing, that *is* two sources agreeing and both may be cited. The
prohibition is on one source dressed as two.

**What is mechanical, and what is not.** The `emits` check is exact and catches a source handing
back another corpus's citations. It cannot catch a doc source that re-serves entry text under a
fabricated `docRef` — that would be indistinguishable from a real corpus to any check we could
write. The rest of the rule therefore lives in the module doc on `productDocsSource` and here, and
binds whoever populates the corpus.

**Scope.** This binds Phase 2 as well: live-data tools cite the read model that produced a figure
and must not also re-cite a library entry describing the same figure. Two citations must always
mean two corpora.
### NZC-085 — Grounded answering: the model's citations are a claim to be checked [Confirmed 16 Sep 2026]

**Decision.** The help drawer answers from approved knowledge, and a model's output is treated as
an unverified **claim** rather than a result. Every reference a draft returns is resolved against
the exact candidate set that draft was given; an answer survives only if all of them resolve. The
model is injected behind an `AnswerModel` interface, so the rules hold without a key, a network or
a bill, and generation being switched off is a supported state rather than a fault.

**Why a second check, when Phase 0 already made uncited candidates unrepresentable.** Those are
different guarantees. NZC-083 made an uncited *candidate* impossible; it said nothing about an
uncited *answer*. A model can fail in two ways that matter: prose with no citation, and — the
harder one — prose footnoted to a reference it was never given. The second is worse, because the
answer then *looks* sourced. A footnote to a source that does not exist manufactures the
appearance of provenance, which is more damaging than visibly having none.

**One bad reference refuses the whole answer.** The salvage — drop the unresolvable citation, keep
the rest — was rejected. A model that invented a reference has demonstrated it is not tracking its
sources, and the prose it produced in that state is exactly the prose whose provenance has just
been disproved. Keeping it leaves a claim standing on whichever citations happened to survive.

**A refusal is not a gap.** A withheld answer is said as a fault in the answer, explicitly not as
an absence in the knowledge, and worded so the reader can tell which happened. Telling someone
their question is unanswered — when in truth an answer was drafted and refused — would send them
off to write a library entry that already exists.

**The model is never handed a question it cannot source.** Retrieval runs first and decides on its
own evidence; generation is reached only when there is something to write from. This is the
cheapest safeguard in the design, and it also means an ungroundable question costs nothing.

**Four outcomes stay visibly distinct**: answered, abstained, the request failing, and still
waiting. Collapsing a failure into an abstention would be the platform's oldest failure mode — a
broken query rendered as an honest-looking nothing — so a failed ask says it is a fault at our end
and does not claim the library is empty. In every non-answered case the **retrieved sources are
still shown**: they were real, only the prose was in doubt.

**Page context is framing, never evidence.** The drawer tells the user their page will be sent, so
it is; but it is passed as help in reading an ambiguous question and declared non-citable in the
prompt, because it is the app's word about where someone is standing, not a ratified source.

**Watch-point.** The HTTP adapter is the one path no test exercises — by design, since there is
no key in CI. `parseModelDraft` is covered thoroughly and every rule above the model interface is
covered without a network, but the request shape, headers and response envelope have only ever run
against a fake. **The first use of a real key on staging is a supervised check, not a silent
enablement**: ask one question whose answer is in the library and confirm a cited answer; ask one
that is not and confirm the abstention. A wrong request shape fails safe — a non-2xx throws, is
reported as a fault, and the retrieved sources still show — but safe is not the same as noticed,
and an adapter that always failed would look identical to a library that never matches.

**Model.** `claude-sonnet-5` by default — a grounded lookup over a handful of short entries is not
Opus work. `ANTHROPIC_API_KEY` is read at the composition edge (the route) and nowhere deeper,
matching `spendImportIdentity`; `render.yaml` declares the key with `sync: false` and never a
value. Phase 2 (permission-checked live-data tools) remains future work and NZC-069 stays held.

### NZC-086 — The gate scans the files, not just what they compile to [Confirmed 16 Sep 2026]

**Decision.** CI fails if a merge-conflict marker appears in any tracked file
(`npm run check:conflicts`, `scripts/check-conflict-markers.mjs`), and it runs first, before
typecheck and build.

**Why — the #194 incident.** During a rebase on `feat/grounded-answering`, conflict markers were
resolved in `DECISIONS.md` and left in place in `CLIENT_WORKSPACE_BACKLOG.md`, staged by a
`git add -A`, and committed. **The full gate passed**: typecheck clean, build green, 964 tests
passing. It survived the gate, a push and a PR, and surfaced only when the next rebase produced a
duplicated table row.

**The class of failure, not the instance.** Nothing in the gate was broken or badly written. Every
check in this repo answers *does the code work?*, and a corrupted document answers that with a
confident yes — it compiles, because nothing compiles it. The damage was therefore invisible by
construction, and no amount of additional test coverage would have found it. That is the argument
for a check that reads the files themselves rather than what they compile to, and it is the same
argument that put the `migrations` job in CI: the useful checks are the ones asking a question the
unit tests structurally cannot.

**Documents here are load-bearing.** `DECISIONS.md` is the governance record and the backlog is
the delivery state. A half-merged one is worse than a broken build, because a broken build
announces itself and a mangled table does not.

**One deliberate piece of leniency.** Start and end markers (seven `<` or `>`) fail on sight —
nobody writes those on purpose. The middle separator, a row of seven `=`, is **also a valid
Markdown setext heading underline**, and this repo is mostly Markdown; so it is only treated as a
conflict when the same file also carries a start or end marker, which a real conflict always
writes. A check that eventually rejects a legitimate document gets switched off, and a check that
is switched off protects nothing. Strictness is spent where it is free and withheld where it would
cost credibility.

**Not a hook.** Nothing is installed into anyone's working copy: a local hook can be skipped with
`--no-verify` and cannot be relied on for the guarantee. CI blocks the merge, which is where the
guarantee has to live.

### NZC-087 — The staff portal preview is the capability the matrix already had [Confirmed 16 Sep 2026]

**Decision.** Staff open a **read-only preview** of a client's portal from the client Overview
("Go to portal"), rendered **under their own identity**. It is gated on the **existing**
`support.portal_impersonate` capability. **No new capability, and the permission matrix stays at
v4.**

**The reconciliation, which changed the plan.** The brief called for a new `portal.preview` at a
new matrix version, and asked first whether the `support_portal_impersonate` already in the matrix
made that a duplicate. It does. The capability is spelled **`support.portal_impersonate`** and has
been in the matrix since v1, described there as:

> "enter a client's portal context … every entry is audited and time-boxed; it grants a
> **read/preview context, never portal-user credential access**."

That is this feature, written down before it was built — declared, carried through four matrix
versions, and never enforced, because nothing had yet existed to enforce it. Adding
`portal.preview` beside it would have split one concept in two and left the older name meaning
nothing while the newer one did its work. So the preview enforces the capability that was waiting
for it, and the matrix does not move.

**Holders.** Admin and Consultant, at scope `all` — unchanged. There is **no CRM role** in this
system (`admin, consultant, reviewer, finance, viewer`), so "client-facing staff" is those two.
The scope matters less than the comparison: it is the *same* scope both roles hold `client.view`
at, so anyone who can preview a client could already open that client in the staff console. The
preview therefore grants **no new data reach**, and a test asserts the preview scope never exceeds
the `client.view` scope rather than trusting that to stay true.

**Preview, not impersonation.** No portal session, no client principal, nothing attributable to
the client. The audit records `portal.preview.open` with the staff actor. This is not pedantry:
impersonation makes the audit trail lie, and an action recorded against a client who was not at
their desk is worse than no record, because it looks like evidence.

**One read path.** The plan and readiness come from `getPortalClientStrategies` and
`getPortalClientReadiness` — the client portal's own resolvers, not a staff-side copy. Every rule
they carry (`include_in_report`, withdrawn excluded, drafts withheld, as-at and provenance)
applies by construction rather than by imitation. The **UI is shared too**: the preview renders
`PortalReductionPlan` and `PortalReadiness` with the model passed in, so there is one renderer, not
two. "This is what your client sees" is only true while there is a single thing to be wrong.

**Read-only is structural.** One write exists in the whole path — the audit row — and a test
counts the SQL statements to keep it that way. The feature-flag gates are applied exactly as
`PortalHome` applies them, so a surface switched off for clients is absent from the preview too;
without that a consultant could walk a client through a page the client cannot open.

**A GET with one side effect**, deliberately: the thing being audited *is* the looking, so there
is no later action to hang the record on. Splitting it into a POST-to-open and a GET-to-read would
allow a client's portal to be read with no record of who read it.

### NZC-088 — The portal enrolment and login flow needs a revamp [Parked 16 Sep 2026]

**Status: parked, not started.** Recorded so it is tracked rather than remembered.

**What is wrong.** The enrolment and sign-in path — invite → single-use setup link →
password/TOTP → `/portal/login` — is unreliable on staging: "Register unavailable" and "Sign-in
could not be completed" across the panels. It is the reason NZC-080's walk-through could not
proceed through a real portal login, and the reason the staff preview (NZC-087) was built.

**First thing to check.** **`NZI_WRITE_API_ENABLED` is very likely not `true` on staging.** The
invitation endpoint returns `503 WRITE_API_DISABLED` when it is unset, which would produce exactly
these symptoms on exactly these panels. The variable is **absent from `render.yaml`**, so it is a
dashboard-only setting and nothing in the repo would show its value. Confirm that before treating
anything else as a bug.

**Also in scope when this is picked up.** The single-use setup link is shown once, on screen, and
staging cannot email it (`NZI_DATABASE_BOUNDARY=isolated-non-production` makes mail
suppress-and-log, NZC-076). A person who navigates away has no way back to the token and must
issue another invitation. That is a trap rather than a safeguard, and the recovery path's
"immediately ends all sessions and suspends credentials" wording makes re-issuing feel more
destructive than it is.

**Not built here.** The preview deliberately does not depend on any of it: it uses the staff
session, so it works whether or not the portal login does.

**Consequence for NZC-080.** The content, gate and single-tenant criteria are acceptable through
the preview. The criteria that depend on the portal auth path itself — cross-tenant isolation
*via portal login*, the login/MFA flow, session-ended behaviour — are **deferred to this decision
and marked deferred on those rows, never silently ticked**.

### NZC-089 — Reference data is one governed subsystem, seeded from a live export [Confirmed 17 Sep 2026]

**Decision.** The lookups the client and job smart-searches resolve against live in a single
reference-data subsystem: `reference_categories` (the catalogue) and `reference_values` (the
curated values), plus a team roster on `memberships`. Migration `0089`. First slice: **Industries,
Referrals, Team**, with read APIs and one shared smart-search component.

**One table, not eighteen.** Eighteen categories are coming. A table each would be eighteen
migrations, eighteen read models and eighteen admin screens differing only in their labels — and
the nineteenth category would need all of it again. So a category is a row and its values are rows:
adding "Payment Terms" later is an INSERT, not a migration. The one thing categories genuinely do
not share — the SIC an industry carries — is a nullable column, because one optional column is
cheaper than a jsonb blob nobody can index or constrain.

**Scope describes who curates, not where it lives.** Shared standards (Industries, Currencies, UoM)
and firm configuration (Referrals, Job Types, Portfolios) differ in who may edit them and how they
are seeded, and that is recorded on the category. **Storage stays organisation-partitioned for
every category.** The alternative — a nullable `organisation_id` with a policy that special-cases
it — is a second RLS shape, and an organisation-scoped row that some policy lets another tenant
read is exactly the failure the isolation model exists to prevent. Shared categories are
provisioned into each organisation, as levers and the SRS framework already are.

**Archive is deactivation.** The live admin's "Archive" is `active = false`, and `DELETE` is
revoked. A client record pointing at an industry must stay explicable after that industry stops
being offered: it still renders where it was chosen, and simply leaves the search.

**Reconcile by reading, not by idempotency key** — the rule NZC-085's seed was rebuilt around, for
the same reason. An import is not a one-off: a corrected export, an edited list, a later loader.
Matching prefers the export's own `source_ref` and falls back to the normalised label, so a
**rename is an update** and the records pointing at the value stay pointed at it. Matching ignores
`active`, so re-importing something archived reinstates it rather than inserting a second copy
beside it. A re-run bumps no versions: version churn on an unchanged import would make every load
look like an edit in the audit trail.

**`archiveMissing` is opt-in.** Treating the export as the whole truth is right when it *is* the
whole truth and catastrophic when it is a partial file — it would archive the firm's entire list.
The destructive reading of an ambiguous input is never the default.

**The roster carries names, and never grants access.** `memberships` had `user_id`, `role_id`,
`status` and nothing else — portal users have had a `display_name` since 0018, staff never did,
because nothing had needed one until a form asked a consultant to pick a colleague. The import
fills names and emails **only**: role and status are this system's access decisions, audited here,
and letting a reference-data file overwrite them would make an import a permission grant. A person
in the export with no membership is reported, not created.

**Live is production and export-only.** The curated lists arrive through the live admin's
Import/Export, run by Francis, never a database dump — a dump would carry secrets and would mean
writing to a system this repo may not touch. The loader is built and CI-tested against synthetic
fixtures first, then pointed at the real export.

**No matrix change in this slice.** The lookup-admin capability belongs with the admin surface,
which follows; nothing here is reachable except through existing staff reads.

**One smart-search, extracted.** The app had two typeaheads and no primitive: `TemplateSearchBar`,
welded to the job factor library and the command behind it, and a bare `<datalist>` in data entry.
A `<datalist>` cannot return an **id** (it yields the text typed, so "Maya Osei" would be stored
rather than `m.osei` — the whole point of moving owner and manager off free text), cannot show a
second line, and behaves differently per browser. `SmartSearch` in `@nzi/ui` is the one
implementation all four fields will use.

### NZC-090 — Client identity fields are references, with the stored text as a first-class fallback [Confirmed 17 Sep 2026]

**Decision.** `sector`, `referral`, `client_manager` and the client owner become references to the
curated lookups (NZC-089) and the team roster. Migration `0090` adds `sector_value_id`,
`referral_value_id` and `client_manager_user_id` with real foreign keys; the owner reuses
`owner_user_id`, which has existed since `0066`. The existing text columns keep their values.

**Recorded late.** This was cited in eleven files before it was written down here, which is its own
small lesson: a code comment naming a decision is a pointer, and a pointer to nothing is worse than
no pointer, because it reads as though the reasoning exists somewhere.

**The fallback is the path, not the safety net.** Every field resolves id → curated label → the
client's own text, unconditionally. The first dry run settled the question: on the demo org nearly
every sector, owner and manager resolved to stored text, and staging is smaller and more synthetic
than live. Three reasons it stays true after the lists improve — archive is deactivation, so a
client keeps pointing at a value that has left the search; every client predating the lookups holds
text typed against nothing; and "Food & beverage" and "Food and Drink" are one industry to a person
and two strings to a matcher. Aliases will shrink that population, not empty it.

**Resolution happens in the read.** Scalar subselects beside the existing `primary_contact` one, so
`sector`, `owner`, `referral` and `clientManager` already carry the resolved label and no call site
can implement two of the three steps and forget the third. A `references` block carries the id and
which step produced the label, for a surface that wants to flag an unresolved value.

**A script may fill an owner; it may never move one.** `owner_user_id` is what `own_clients`
resolves against, so writing it decides who holds certain powers over a client. The backfill fills
a null one from an unambiguous name and never changes one already set; a disagreement between the
stored owner and the name on the record is reported for a person to settle. Re-pointing ownership
is a deliberate, audited act.

**What ownership actually costs, measured rather than assumed.** Assigning a client to a colleague
does **not** take it out of the creator's sight: no role holds `client.view` at `own_clients`, so
visibility is organisation-wide. Exactly three consultant capabilities follow the owner —
`baseline.rebaseline`, `portal.admin`, `audit.view`. Narrowing visibility to owned clients was
considered and **declined**: it is a confidentiality-model change, not a side effect of this one.

**The create form defaults the owner to whoever is creating**, overridable, filling only a blank.
Create-and-own should cost nothing; handing a client over stays a deliberate edit.

**Referential integrity came cheaply.** `value_id` is unique within an organisation by construction
— `"<category>:<slug>"` — so one unique constraint lets `clients` carry real foreign keys, instead
of three redundant category columns to satisfy composite ones.

### NZC-091 — A red main is not mergeable-past [Confirmed 17 Sep 2026]

**Decision.** The repository requires both CI jobs — `typecheck · build · tests` and
`migrations apply to a real Postgres` — to pass before a pull request may merge, and requires a
branch to be **up to date with `main`** before merging.

**Why, with the evidence.** A real-Postgres test introduced by #203 failed roughly one run in
eight, and #205 merged on top of it. Nothing stopped that: the check was advisory, so a red main
stayed mergeable-past, and an intermittent failure is the kind most likely to be re-run away rather
than investigated. Two further pull requests queued behind a failure nobody was obliged to fix.

**Why "up to date before merging" as well.** The two checks answer "is this branch green?", not "is
`main` green with this branch in it", and those differ whenever two branches are in flight. This
repository makes that concrete: migrations are numbered, so two branches can each add a `0090`,
each pass alone, and collide only once both are in. Requiring the branch to be current turns that
from a broken `main` into a rebase.

**The cost, stated.** Requiring up-to-date means rebasing whenever `main` moves, which at the
current cadence is often. That is the trade: a little more rebasing against never having to work
out which of the last four merges broke the build.

**What this does not do.** It is a repository setting, so nothing in this repo enforces or records
it — the same class as NZC-086's conflict markers and §15's auto-delete: guarantees that cannot
live in the code they protect. If the setting is ever removed, no test will notice, which is the
reason it is written down here.

**Related.** NZC-086 (the gate scans the files, not just what they compile to); DESIGN_CONVENTIONS
§15 (a merged branch is deleted, and a merge is verified on `main` by content).

### NZC-092 — A job records the period it reports on, and its year is derived forward only [Confirmed 17 Sep 2026]

**Decision.** Migration `0091` gives `jobs` a `reporting_period_start` and `reporting_period_end`.
From Part 1, a new job's `reporting_year` is the calendar year its reporting period **ends** —
31/12/2024 → 2024, 31/03/2025 → 2025 — derived by a new helper and never typed. Existing jobs keep
the year they were stored with, and their periods stay null.

**Why the period has to be stored.** `reporting_year` alone cannot say which period a job covers
for any client whose financial year does not end in December: FY2024 for a March year end is
01/04/2024–31/03/2025. Four places reconstruct that from the year plus the client's
`financial_year_end_month`, which is correct only while every job's period is exactly the client's
financial year. It stops being correct for a part-year first engagement, a transition period after
a year-end change, or a client reporting on a different basis from its statutory accounts. Storing
the two dates the consultant entered makes the period recorded rather than recomputed.

**The two rules cannot both label the same period**, and #210 measured the gap rather than
estimating it: identical for a December or unset year end, and off by exactly one year for every
other. A March year end's FY24 would start reading as FY25. So the new rule applies **forward
only** — a new job records the period entered and the year derived from its end; an existing job
keeps what it was stored with. Nothing re-derives an old job's year.

**Which is why `0091` backfills nothing.** Computing a period from an existing `reporting_year`
would invent dates under the start-year convention that Part 1 then reads back under the end-year
one, moving the label silently. A null period says "not recorded", which is true and which a read
can state honestly. The characterisation test from #210 is the tripwire: if it moves, the change
has reached backwards.

**The database enforces the ordering**, not only the validator. `jobs_reporting_period_ordered`
refuses a period ending on or before it starts, because a server validator can be bypassed by the
next writer and a CHECK constraint cannot.

**The job's client manager is one column, not two.** `client_manager_user_id` arrives with the same
membership foreign key `0090` gave `clients`. No `client_manager_name` comes with it: `owner_name`
is already a name typed when there was no roster to choose from — exactly the text half of the
NZC-090 pattern — and a second column meaning the same thing is two copies that drift. The resolver
reads the id and falls back to `owner_name`, so historical jobs keep showing the person they named.
The column keeps its historical name; renaming it is neither trivial nor safe, and the name is a
fact about when it was added rather than a claim about what it means now.

**Related.** NZC-090 (id beside the text, the text as a first-class fallback); NZC-040 (dd/mm/yyyy);
the #210 characterisation test.

### NZC-093 — A job's dates are checked against a plausible window, and the server is the check [Confirmed 17 Sep 2026]

**Decision.** All four of a job's dates — job start, job end, reporting period start, reporting
period end — are required, must be real calendar dates written as four-digit years, must fall
between 2000 and five years after today, and must be ordered within each pair. One exported
function, `jobDateIssues`, holds the rules; the create form calls it and the command calls it.

**The bug is on record.** A job on live starts in the year 98655. A native `<input type="date">`
accepts whatever year is typed into it, and nothing behind the form disagreed. So the browser check
is a courtesy that saves a round trip and the **command decides** — a client-side guard is one
devtools panel away from irrelevant, and this is the same reasoning as every other validation in
the command layer, applied to a field that had been trusted.

**Plausible, not correct.** A window cannot know whether a period is the right one; it can only
refuse one nobody meant. 2000 is the floor because carbon accounting at this firm does not predate
it. The ceiling is five years ahead so that a job planned for a future reporting cycle is accepted
while a typo three digits wide is not.

**The ceiling is computed, never written down.** A hardcoded year is a bug with a delayed fuse:
correct until the January it silently begins refusing next year's work, with no test failing and
nobody thinking to look at a constant.

**One implementation, so the two sides cannot drift.** A second bespoke date check beside the shared
one is how a form comes to accept what the server refuses. `dueDate` is deliberately not treated as
a job-only word — `srs.assessment.item.set` has one too, for when a client action is due, and an
SRS action is rightly not held to a job's reporting window.

**Every path, of which there is currently one.** The brief asks that create and edit both validate.
This console has no job-date edit command — `createJob` is the only writer of `start_date` and
`due_date` — so the guarantee is made structurally rather than by repetition, and a test fails if a
second copy of the rules appears.

### NZC-094 — The jobs list opens on the work, not on a statement about it [Confirmed 17 Sep 2026]

**Decision.** The dark "NZI delivery command" band and its ✓ trust pills are removed from the jobs
list. The page opens on the four stat tiles and the table. The tiles stay; they were never the
problem.

**Why.** The band restated the platform's own assurances — official numbering, named ownership,
audited workflow — above the work rather than showing any of it, and a consultant opening the jobs
list is looking for jobs. A ✓ that is present whenever any job exists is not evidence of anything;
it reports that the list is non-empty in the vocabulary of assurance.

**Only on Jobs, deliberately, and this leaves a visible inconsistency.** The same pattern renders on
Clients, Datasets, LCA, Platform and Sales. Part 1's brief covers the jobs list, and removing a
shared component from five screens nobody asked about is a larger change wearing a smaller one's
clothes. The shared style stays in place and untouched. Whether the other five follow is a decision
of its own; until it is taken, the two treatments coexist and that is a known state rather than a
missed edit.

**Related.** The list's Owner column now reads "Client manager" (NZC-092), so the column and the
form use one word for one thing.

### NZC-095 — Only a family that reports on a period has one [Confirmed 17 Sep 2026]

**Decision.** `familyHasReportingPeriod(family)` — currently `family === "crp"` — is the single
predicate behind three gates: whether the create form asks for a reporting period, whether the
command requires one, and whether a job gets an emissions config. A job of any other family records
its start and end and nothing else. With no period there is no `reporting_year`: the derivation
returns null rather than a number taken from a start date.

**What this corrects.** Part 1 required all four dates of every family, reading "all four required"
as a rule about dates when it was a rule about carbon reporting. The result was a training course
carrying an emissions reporting year — a value that reads as a fact, that no reader could act on,
and that nothing it produced was ever labelled by.

**One predicate rather than three literals.** The three gates each tested the family separately, so
a second family adopting reporting would have needed three edits, of which the one in the form looks
like presentation and is the one most likely to be missed. The gate in `createJob` was changed to
call the predicate even though it is behaviour-identical today, because a literal that agrees by
coincidence is the kind that stops agreeing silently.

**The requirement is family-driven; the validation is value-driven.** A training job needs no
period, so its absence is not an issue — but a period supplied anyway is held to exactly the same
plausible window and ordering as a CRP job's. Keeping those separate is what stops "this family
need not have a period" becoming "this family's dates are not checked" (NZC-093 is unchanged: still
every family, still whenever a date is present).

**The stored period is now read.** `jobs.reporting_period_start`/`reporting_period_end` were
write-only when `0091` added them: the create path wrote both columns and every reader used
`job_emissions_config` instead, so the same fact sat in two places with only one of them consulted
— the redundancy NZC-092 argues against for `client_manager_name`, in the migration that argues it.
The job read model now carries `reportingPeriod` from those columns, and they are the source of
record for what a job reports on.

**The equivalence anchor.** For a client whose period is its statutory financial year, the window
stored by the new path equals the window the old reconstruction produced — asserted against
`reportingPeriodForYear` for a December, March, September and unset year end. **Window only.** The
*label* differs by one year for a non-December year end, correctly and by design, and pinning the
two conventions together would fail the moment either is used as intended. #210 owns the label
difference; this owns the window identity.

**Not fixed here.** `spendImportIdentity.ts` falls back to a calendar year when a job has no config
window, ignoring the client's financial year end. It is a real defect, and it is an **idempotency
identity** — changing it would change how a re-import reconciles and could duplicate rows. It needs
its own reconcile-by-reading analysis and is tracked separately, not folded in.

**Related.** NZC-092 (the period is recorded, the year derived from its end); NZC-093 (the plausible
window); NZC-070 (a reporting window is the client's financial year, now read rather than inferred).

### NZC-096 — The reporting year is a label; the period is the identity [Confirmed 17 Sep 2026]

**Decision.** `reporting_year` is a display label and nothing else. Every read that groups, dedupes
or looks a value up by reporting period keys on the **period** — the two dates — not on the year.
The end-year derivation from NZC-092 is retained; it is a good label and it was never the problem.

**Forward-only kept each job's own label stable, which is necessary and not sufficient.** NZC-092
ensured an existing job keeps the year it was stored with and a new one derives from its period
end. Each job is therefore internally consistent. The collision is not within a job: it is **two
jobs meeting in one map**. The start-year and end-year conventions disagree by a year for any
non-December financial year end, so one client can hold

```
legacy job   01/10/2025 → 30/09/2026   reporting_year 2025
new job      01/10/2024 → 30/09/2025   reporting_year 2025
```

— adjacent, non-overlapping, and indistinguishable to anything keyed by the number. Only making the
period the identity closes that, and it stays closed for a part-year period ending in the same
calendar year as a full one, which needs no legacy row at all.

**What the collision did before this.** A year of reviewed emissions vanished from a client's
history when the second job overwrote the first in a year-keyed map, with nothing reporting the
loss. An intensity denominator resolved by `.find()` on the year returned whichever row came first,
dividing one period's emissions by another period's turnover and presenting the result as a figure.
Both silent; neither detectable from the output.

**Adjacent periods are two; overlapping periods are one.** The year key prevented a client that
changed its financial year end from showing 01/01/2024–31/12/2024 beside 01/04/2024–31/03/2025 —
nine of the same months described twice — but only as a side effect of being coarse. Keying by
period alone would have let both through, so the rule is now stated: among **overlapping** periods
the latest end wins, which is the preference NZC-067 already expressed. The pre-existing NZC-067
test passes unchanged against it.

**Stored period first, reconstruction only when there is none.** Every re-keyed read resolves the
period from `jobs.reporting_period_start`/`_end` (NZC-095), falling back to the emissions-config
window, and only then to the financial-year-end reconstruction. **A job that has a period never
reconstructs one.** Where a legacy job has neither, the label still separates the rows — that is all
such a job has ever had, and matching it on the label changes nothing about it.

**Where the year is structurally the only key, ambiguity is reported rather than guessed.** The
portal trend carries a year, not a period, so its period lookup is keyed by year. A year naming two
periods now resolves to **null** — the denominator says it is unavailable, with a reason — instead
of taking whichever row was read last. Truth before apparent availability. Carrying the period
through the trend itself would resolve it properly and is the larger change this does not make.

**Category C is unchanged and must stay that way.** `job_intensity_values` is keyed by
`(organisation_id, job_id, reporting_year, metric_key, period_key)`, so no two jobs can collide
there. It does mean a job's own `reporting_year` is a real key for its recorded values: **it must
never become editable while values exist against it**, or those rows orphan. There is no job edit
path today, and this is the reason to think before adding one.

**Ordering by period rather than by year is not done here.** The prior-job selection for
rollforward (NZC-063) and the prior-year reads that compare `< currentYear` still order by label.
That is a change of carbon output, it is retroactive because the selection is recomputed on read
rather than persisted, and it is taken separately with its own characterisation and review.

**Not fixed here, flagged.** `spendImportIdentity.ts` falls back to a calendar year ignoring the
client's year end. Real defect, but an idempotency identity — changing it could duplicate on
re-import. Its own reconcile-by-reading analysis, tracked separately.

**Related.** NZC-092 (the period is recorded, the year derived forward only); NZC-095 (the stored
period is the read source); NZC-067 (a job stands for a reporting year); NZC-063 (rollforward).
### NZC-097 — A test suite owns its database, so isolation is structural rather than scheduled [Confirmed 17 Sep 2026]

**Decision.** Every test that builds a real schema gets a database of its own, created and dropped
by `tests/support/database.ts` from the base `NZI_TEST_DATABASE_URL`. No suite shares a database
with another, and the runner may schedule them however it likes.

**The failure this removes.** Nine suites each ran `DROP SCHEMA nzi_console CASCADE` against the one
database the environment named, and `node --test` runs files in parallel processes. Each one's drop
deleted the tables the others were partway through using, so the result depended on which finished
first: `reportFreeze` passed alone and failed beside `portalPreviewContract`, and which of the nine
failed varied per run.

**This is worse than a flaky test, because it is indistinguishable from a real one.** A red on a
pull request touching a carbon path has to mean something. While the suites could clobber each
other, every red needed a re-run to classify, and a re-run that goes green teaches the habit of
re-running — which is how the intermittent failure behind NZC-091 survived long enough to be merged
past.

**A database each, not a schema each.** The schema name is written into the migrations
(`CREATE SCHEMA … nzi_console`, and every statement is `nzi_console.`-qualified), so isolating by
schema would mean rewriting the SQL under test — and the point of these suites is that they run the
real migrations. A database costs nothing here and needs no change to the thing being tested.

**Two shapes, deliberately.** `createDisposableDatabase` builds and migrates for a suite that wants
that done for it; `ensureDisposableDatabase` hands back an empty database for a suite that already
knows how to build its own fixture. Seven of the nine took the second, because their setup was
working and correct, and rewriting nine careful fixtures on a carbon path to fix a scheduling
problem would be a larger change with more ways to be wrong.

**Databases are left behind after a run.** They are recreated from nothing next time, and a failed
suite's rows are the first thing anyone wants to look at.

**The boundary guard is not weakened.** Each derived name is checked by the same disposable-name
rule as the base, and refused if it matches `NZI_ISOLATED_DATABASE_URL` — a per-suite database is
still never staging.

**Related.** NZC-091 (a red main is not mergeable-past — this is what makes a red mean something);
§14 (run twice, and over a dirtied database).
