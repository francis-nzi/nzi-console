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
| NZC-008 | One canonical scope-row model | Open |
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
| NZC-020 | Isolated-backend data strategy (synthetic vs anonymised) | Open |
| NZC-021 | Reporting engine: reuse vs rebuild | Open |
| NZC-022 | Explicit permission / SoD matrix | Open |
| NZC-023 | Xero/Stripe sandbox-only during redesign | Proposed |
| NZC-024 | Separate job-family modules over a shared spine | Proposed |
| NZC-025 | Single shared, sequential job-numbering service | Proposed (format/gap policy Open) |
| NZC-026 | One SVG-first chart engine (`@nzi/charts`) for all surfaces | Proposed |
| NZC-027 | Charts derived from data, never captured; content-addressed cache | Proposed |
| NZC-028 | Manifest-driven report assembly with validation as a hard publish gate | Proposed |
| NZC-029 | One chart asset across screen/PDF/portal, with provenance; no runtime browser provisioning | Proposed |

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

### NZC-008 — One canonical scope-row model [Open]
The live schema has **two** measurement models: `job_scope_rows` (qty/uom/factor/calc_tco2e/override,
factor-FK) and the older `crp_scope_entries` (amount/unit/factor/tco2e/method, `is_archived`). The console
must pick one canonical model and treat the other as migration input.
*Recommendation:* adopt `job_scope_rows` (richer provenance + override reason + factor FK) as canonical.
*Decision owner: Francis. Blocks: Emissions/Jobs data model.*

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

### NZC-019 — LCA/PCF is a distinct family with its own inner model [Proposed]
LCA/PCF shares the job spine and factor engine but has its own model: assessment → BOM line item →
transport leg → scenario, with factor confidence/readiness and a supplier library, following ISO
14040/14044, ISO 14067, ISO 14025 / EN 15804. It gets its own workspace, not the CRP scope-row grid.
*Source: `WORKFLOWS.md` §12; live `lca_routes`, migrations 0058–0067.*

### NZC-020 — Isolated-backend data strategy [Open]
When moving from mock to wired-but-isolated, decide between **fully synthetic** seed data and an
**anonymised production clone**. Neither may include real client PII in this repo/service.
*Options:* (a) synthetic only — safest, least realistic; (b) anonymised clone — realistic, requires a
vetted anonymisation pipeline. *Decision owner: Francis + data-protection. Blocks: Phase 3.*

### NZC-021 — Reporting engine: reuse vs rebuild [Open]
The live report engine (`job_report_routes`, 239KB) + template/variable model + PDF/DOCX/certificate is
large and mature. Decide whether the console **reuses** it via the canonical service (faster, keeps
parity) or **rebuilds** the template/variable layer natively (cleaner, more work).
*Recommendation:* reuse via canonical service initially; rebuild only if the redesign requires it.
*Decision owner: Francis. Blocks: Reports workspace, Phase 3.*

### NZC-022 — Explicit permission / SoD matrix [Open]
Define a named-permission matrix per capability (view/edit scope, change stage, edit financials, publish
to portal, run prospecting, manage datasets, admin), server-enforced, with cross-domain checks on every
handoff. Replaces the live platform's coarse/inconsistent guards. *Model on FuelCap's SoD matrix.*
*Decision owner: Francis. Blocks: Platform & audit, Phase 3 writes.*

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

### NZC-025 — Single shared, sequential job-numbering service [Proposed; format & gap policy Open]
All job numbers come from **one authoritative allocator** and are **sequential across every family** (a
CRP, an LCA and a training job draw from the same counter). Implemented as a single Postgres sequence or a
numbering table guarded by an advisory lock, allocated **transactionally and idempotently** with job
creation (NZC-014). Replaces today's ad-hoc free-form `jobs.job_number` unique varchar.
**Open sub-decisions for Francis:** (a) **format** — bare global-sequential numbers, or a display
prefix/badge per family over the *same* underlying counter (never a second counter); (b) **gap policy** —
allow gaps from cancelled creations (sequence-native, simplest) or guarantee gapless (needs a reservation
model). *Source: user requirement, 24 Aug 2026; `ARCHITECTURE.md` §6.3.*

### NZC-026 — One SVG-first chart engine for all surfaces [Proposed]
A single workspace package `@nzi/charts` renders a declarative chart spec to **SVG**, used identically on
the console screen, in the PDF and in the client portal. Replaces the live platform's **three** rendering
stacks (matplotlib + Plotly/Kaleido + human-captured `job_widget_pngs`). SVG-first removes the need for a
headless browser to draw charts. *Source: user requirement (graphics dysfunction), 24 Aug 2026;
`WORKFLOWS.md` §6.1; `GRAPHICS_PIPELINE.md`.*

### NZC-027 — Charts derived, never captured; content-addressed cache [Proposed]
A chart is a pure function of *(reviewed job data + spec + tokens + version)*. There is **no human capture
step**. Any cached render is keyed by a **hash of that input**, so a data change forces regeneration and
staleness is structurally impossible. Retires `job_widget_pngs` as a source of truth (at most a
content-addressed cache). Directly fixes the live stale/missing-image failures. *Source: `WORKFLOWS.md`
§6.1; `GRAPHICS_PIPELINE.md` §2, §3.4.*

### NZC-028 — Manifest-driven assembly with validation as a hard publish gate [Proposed]
Reports are assembled **only** from a versioned manifest (sections → required/optional charts), and
validation (missing / unresolved / incoherent chart) **blocks** publish, PDF and portal push. This adopts
and *wires in* the `report_manifests.py` + `report_manifest_validation.py` layer the live platform built
but left disconnected — so nothing is ever published with a missing or stale chart. *Source: `WORKFLOWS.md`
§6.1; `GRAPHICS_PIPELINE.md` §3.5.*

### NZC-029 — One chart asset across surfaces, with provenance; no runtime browser provisioning [Proposed]
The same rendered chart (same spec + data hash) serves screen, PDF and portal, and carries **provenance**
(job data, factor set/version, spec version) so it expands in the evidence drawer like a scope row. The
runtime download of Kaleido-Chrome and Playwright-Chromium is **eliminated**: charts are SVG (no browser),
and any single retained HTML/SVG→PDF renderer is **pinned and installed at build/deploy**, never fetched
into `/tmp` on first use. *Source: `WORKFLOWS.md` §6.1; `GRAPHICS_PIPELINE.md` §2.8, §3.3.*

---

## Decisions needing Francis first

The **Open** items gate later phases and are the shortlist for the next review:

1. **NZC-008** — canonical scope-row model (recommend `job_scope_rows`).
2. **NZC-020** — synthetic vs anonymised data for the isolated backend.
3. **NZC-021** — reuse vs rebuild the reporting engine.
4. **NZC-022** — the permission / SoD matrix.
5. **NZC-025 (sub)** — job-number **format** (bare-sequential vs display-prefixed) and **gap policy**
   (allow gaps vs guaranteed gapless). The single-shared-allocator principle itself is settled; only these
   two knobs need a call.

The **Proposed** items (NZC-006, 007, 009, 011–019, 023, **024, 026–029**) are recommendations ready to be
confirmed as a batch once reviewed — including the job-family module separation and the whole graphics
redesign, which are direct responses to the two requirements raised on 24 Aug 2026.
