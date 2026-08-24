# NZI Console — Architecture

**What this is.** The target architecture for **NZI Console**, the redesigned front-end for the NZI Pro
(*NZ Insights Pro*) carbon platform. It is grounded in `WORKFLOWS.md` (a ground-truth deep-dive of the
live CRM) and follows the same disciplined approach used for FuelCap: a decision register, evidence-led
UI, migration-owned schema, and explicit domain contracts.

**What this is not.** A rewrite of the live NZI Pro backend, and not a licence to touch production. NZI
Console is an **additive, isolated environment** (separate repo, Render service, and — later — a
non-production database). The live platform keeps running unchanged.

**Reading order:** `WORKFLOWS.md` → this document → `DECISIONS.md`.

---

## 1. Vision

NZI Console turns the sprawling, consultant-operated NZI Pro platform into **one coherent operating
console** organised around how the work actually flows: clients, jobs, the emissions the jobs produce,
the reports that go out, and the commercial and growth activity around them. Its defining idea, already
visible in the scaffold, is the **evidence drawer**: no number appears without its provenance and
calculation lineage one click away.

It is being built **design-first on mock data** so the interaction model and information architecture can
be proven before any backend is wired — and then wired only to a **non-production, isolated** backend.

### 1.1 Current state (24 Aug 2026)

- **Monorepo** (npm workspaces + Turborepo): `apps/console` (Next.js App Router, TS), `packages/ui`
  (design system: `AppShell`, `WorkspaceRail`, `TopBar`, `EvidenceDrawer`, `Icon`, tokens), `packages/mock-data`
  (illustrative, no PII).
- **Screens built:** Control Room home (portfolio overview), **Job workflow** (`/jobs`) — the flagship
  screen: scope-row table + evidence drawer with activity/factor/quality editing, provenance, result and
  **calculation lineage**; Clients board.
- **Nav already declares the target workspaces:** Control Room, Clients, Jobs, Emissions, Datasets &
  factors, Reports, LCA/PCF/CBAM, Business development, Platform & audit.
- **Deployed** as an isolated Render service on `NEXT_PUBLIC_APP_ENV=staging`, mock data only, no
  Supabase/production credentials.
- **Design tokens locked:** Inter type; Emerald `#0BA75E` primary, Deep Pine `#0B7A4B`, Midnight
  `#0B1B2B`, Signal Amber `#FFC24B`, Drop Coral `#FF5C48`, Mint Tint `#DFF5E9`.

---

## 2. Architecture principles

These are lifted from what the live platform got right, and from the failure modes the Business
Development redevelopment brief documented. They are the standing rules for the console.

1. **Evidence before assertion.** Every emissions figure, score, or status must expand to its lineage:
   activity → factor set/version → calculation → any override/estimate flag → whether it counts in the
   total. The evidence drawer is the primary UI, not a decoration.
2. **Truth before apparent availability.** Never render a failed query as a successful zero.
   `empty`, `loading`, `degraded`, `failed`, `success` are five distinct states, everywhere.
3. **One term, one meaning.** Client, Job, Scope row, Factor, Quote, Invoice, Prospect, Lead, Opportunity
   are defined once (see `DECISIONS.md`) and never overloaded (the live "Lead-means-three-things" trap).
4. **The Job is the spine, families are first-class.** One shared job header + a canonical `job_family`
   (`crp`, `training`, `consultancy`, `lca`, `pcf`) + per-family detail + explicit workflow stages with
   history. CRP fidelity is preserved; other families are modelled cleanly, not bolted on.
5. **Provenance and data quality are mandatory metadata.** Dataset, factor row, version, licence,
   country/region, and a data-quality tier (Measured / Estimated / Spend-based / Survey) travel with
   every measurement through calculation and into the report.
6. **Reuse canonical domain services.** Client, Quote, Job, invoice and Xero/Stripe behaviour are
   canonical NZI Pro services. The console composes them; it does not re-implement their SQL.
7. **Migration-owned schema; no request-time DDL.** All schema comes from versioned migrations. Request
   handlers never create, alter, or seed tables.
8. **Atomic, idempotent commands.** Multi-step operations (job create, conversion, handoff, publish,
   invoice) either complete once or roll back completely; retries and double-clicks are absorbed via
   idempotency keys and optimistic locking.
9. **Tenant safety by construction.** Explicit `org_id` predicates + composite tenant keys + least-
   privilege RLS. A missing tenant context defaults to denial.
10. **Consultant-plus-client model.** Two principal types (staff, portal). The client portal is a
    constrained mirror of internal data entry, sharing the model and validation, gated by access grants
    and data-entry expiry.
11. **AI is task-specific, grounded and advisory.** AI assists categorisation, drafting and prioritisation
    against real evidence; it is never the source of truth for factors, emissions, or prospect facts.
12. **Isolation is non-negotiable during redesign.** Mock → wired-but-isolated (non-prod DB) → never
    production credentials in this repo/service.

---

## 3. Information architecture

Navigation follows the workspaces the scaffold already declares. Each maps to a bounded domain.

```
NZI Console
├── Control Room          portfolio overview · work queues · what needs attention
├── Clients               accounts, sites, contacts, targets, timeline, tasks
├── Jobs                  shared spine + shared numbering; one workspace module per family (§6)
│   ├── CRP           scope config → data entry → emissions → review/QA → report → commercials
│   ├── Consultancy   deliverables · effort · reviews
│   ├── LCA           assessment → BOM → transport legs → scenarios → report
│   ├── PCF           product → BOM → factors → report
│   └── Training      course run → sessions → bookings → attendance → certificates
├── Emissions             cross-job emissions, factors-in-use, data completeness
├── Datasets & factors    versioned datasets, factor library, buckets, cross-country audit
├── Reports               templates, versions, action levers, certificates, SRS readiness
├── LCA / PCF / CBAM      assessments → BOM line items → transport legs → scenarios
├── Sales (BD V2)         prospects · leads · pipeline · activities · companies
├── Platform & audit      orgs, users, roles, billing, integrations, audit, settings
└── Client Portal         (separate principal) results + client self-service data entry
```

**Shell (locked):** left **Workspace Rail** · top **command/search bar** (⌘K) · main data area · right
**Evidence Drawer** (provenance + calculation lineage). Implemented today in `@nzi/ui` as
`AppShell` / `WorkspaceRail` / `TopBar` / `EvidenceDrawer`.

---

## 4. The domain model (target)

The console's client-side types (and later, the isolated backend's schema) center on these aggregates.
The mock-data `Job` / `ScopeRow` types are the seed of this model.

### 4.1 Identity & tenancy

`Organisation` (tenant) → `Membership` (user × org × role) with capacity/plan limits. Two principal
types: **StaffUser** (JWT + MFA) and **PortalUser** (per-client, scoped, MFA, access grants + data-entry
expiry). Roles resolve to an explicit **permission matrix** (see `DECISIONS.md`).

### 4.2 Client

`Client` (firmographics + **net-zero trajectory**: net-zero year, interim year, per-scope target year/%,
benchmark year) → `Site` (effective-dated, geocoded, registered-office / vacated) → `Contact` (signee,
portal candidate, recipient) → `Note` / `TimelineEvent` / `Task` / `HealthSnapshot`.

### 4.3 Job (the spine) + families

```
Job (header: client, family, number, reporting_year, status, workflow_stage, owner, dates, quote_id)
 ├── JobPlan (data-collection / first-draft / final-report due)
 ├── Milestones (from template) + completions + stage history
 ├── family = crp        → CrpDetail + ScopeRows (+ spend, commuting, custom factors)
 ├── family = lca | pcf  → Assessment → BomLineItem → TransportLeg → Scenario
 ├── family = training   → CourseRun → Session → Booking → Attendance → Entitlement
 └── family = consultancy→ engagement detail
```

Workflow stages are **explicit and audited** (`workflow_template` → ordered `stage` → per-job
`stage_history`) — the model the job-type brief asks for and FuelCap already demonstrates. **Each family
is a separate workspace module over this shared spine, with one shared job-numbering service — see §6.**

### 4.4 Scope row — the atomic measurement

`ScopeRow { scope, level_1..4, report_label, activity(qty,uom), factor(dataset, factor_row, version,
ghg_unit), calc_tco2e, override(tco2e, reason), quality_tier, provenance, enabled, lineage[] }`.
Emissions = `qty × factor → tCO₂e`, override with mandatory reason, `enabled` decides inclusion. The
**lineage array is the evidence drawer's content** and is already modelled in mock data.

### 4.5 Factors & datasets

`Dataset { source, analysis_type, country, region, currency, year, version, licence }` → `Factor`
(scope, levels, uom, ghg_unit, value). `CustomFactor` (client-specific, year values). `DataEntryBucket`
(what the portal may self-serve, and its allowed factors). `DatasetResolution` picks the applicable
factor for a job+scope. Cross-country contamination is an explicit audit concern.

### 4.6 Commercial

`Quote` (versioned: draft → approve → accept → revise) → `Invoice` (client/job, line items, other costs,
convert-from-quote) → `CreditNote`; `PaymentTerm`, `VatRate`; **Xero** projection links; **Stripe** org
subscription. Canonical services own these — the console orchestrates.

### 4.7 Sales (BD V2)

`Company` / `Contact` (provenance + suppression) → `Prospect`/`Candidate` (run-scoped, evidence-backed) →
`Lead` (owner, status, next task) → `Opportunity` (open stages + `OPEN/WON/LOST` status, stage history) →
explicit `Client`/`Quote`/`Job` handoff. Reuses the canonical downstream services; built on the Sales V2
principles (versioned schema, background prospecting worker, idempotent commands, transactional outbox).

### 4.8 Reporting

`ReportTemplate` (versioned) + typed `Variables` → per-job `Assignment` + `VariableValues` →
`ReportData` → `ReportVersion` (immutable snapshot) → outputs (HTML / PDF / DOCX / certificate).
`ActionLever` library (the "Plan" half of a CRP), `SrsReadiness` questionnaire, methodology.

---

## 5. The evidence & provenance model (the signature)

This is what makes it *NZI* Console rather than a generic admin UI, and it is a deliberate parallel of the
FuelCap evidence drawer.

- **Every derived value is expandable.** Clicking a scope row (or a report figure, an emissions total, a
  data-completeness bar) opens the drawer with: the banner state (ok / warning), editable
  activity + unit, the matched factor (with "Change / Match factor"), the data-quality tier, the factor
  set + version, provenance label, the result, and a **calculation-lineage timeline**.
- **Status is honest.** A row with no factor or no activity is visibly **excluded from the total** until
  resolved — never silently counted or silently zero.
- **Quality tiers are visible end-to-end.** Measured / Estimated / Spend-based / Survey are shown on the
  row, carried into totals, and flagged in the report so a spend-based proxy is never mistaken for a
  measured figure.
- **Overrides are first-class and reasoned.** Any manual override records who/why and shows in lineage.

---

## 6. Job-family modularization & shared numbering

A defining redesign requirement: **CRP, Consultancy, LCA, PCF and Training are genuinely different kinds
of work and must be separate modules** — separate workflows and separate page designs — *while* remaining
one coherent platform with **globally sequential job numbers regardless of type**. This is the
"one jobs platform with type-aware workflows, not five disconnected systems" principle from the job-type
brief, taken seriously.

### 6.1 One spine, many job workspaces

```
                         ┌────────────────── shared spine ──────────────────┐
   Job header (jobs): org · client · job_number · job_family · status · owner · dates · quote link
                         └───────────────────────┬──────────────────────────┘
        ┌──────────────┬──────────────┬──────────┴───────┬───────────────┬───────────────┐
        ▼              ▼              ▼                  ▼               ▼
   CRP module     Consultancy     LCA module         PCF module     Training module
   own workflow    own workflow    own workflow       own workflow   own workflow
   own pages       own pages       own pages          own pages      own pages
   own detail      own detail      assessment→BOM     product→BOM    course-run→booking
   own manifest    own manifest    →transport→scenario …             →attendance→cert
```

### 6.2 What is shared vs per-family

| Shared (one implementation) | Per-family (its own module) |
|---|---|
| Job header + `job_family` + **numbering service** (§6.3) | Workflow stages + stage history |
| Clients, sites, contacts, notes, timeline, tasks | Detail data model (CRP scope rows vs LCA assessment vs training course-run) |
| Factors & datasets engine + provenance | Data-entry surfaces & page designs |
| Visualization subsystem + brand tokens (§7) | Report manifest(s) & chart catalogue subset |
| Commercial (quotes, invoices, credit notes, Xero/Stripe) | Family-specific validation & business rules |
| Files, audit, tenancy, permissions, portal plumbing | Family-specific portal views where relevant |

Concretely in the monorepo: a shared `@nzi/job-core` (header, numbering, shared hooks) and a **module per
family** (`apps/console/app/jobs/crp`, `…/lca`, `…/training`, …) or family packages, each owning its
routes, workflow state machine, detail forms, page layout and report manifest — all mounted in the same
shell and reusing the shared packages. A family is added or evolved without touching the others.

### 6.3 The shared job-numbering service [decision NZC-025]

Job numbers must be **sequential and collision-free across every family** — a CRP, an LCA and a training
job draw from **one** counter. Today `jobs.job_number` is a free-form unique `VARCHAR` with a unique
index — allocation is effectively ad hoc, which is fragile under concurrency and across modules.

Target: a **single authoritative numbering service** that every family module calls to allocate the next
number. Requirements:

- **One global monotonic sequence** (a dedicated Postgres sequence or a numbering table guarded by an
  advisory lock / `SELECT … FOR UPDATE`), so numbers are sequential regardless of `job_family` and there
  is exactly one allocator.
- **Allocation is transactional with job creation and idempotent** — a retried "create job" never burns
  or duplicates a number (ties to NZC-014).
- **Format — preserve the official universal `J` format (decided, NZC-025).** Numbers render as
  `J000612`, `J000613`, `J000614` … regardless of family. Store the bare integer and render `J` plus six
  zero-padded digits. Store the family separately and show it as a badge/label (`CRP`, `CON`, `LCA`,
  `PCF`, `TRN`), never as part of the official job number.
- **Gapless (decided, NZC-025).** No skipped numbers: **assign the number only at durable job creation**,
  inside the creating transaction, so an aborted draft never consumes one (assign-on-commit avoids a heavy
  reserve-and-release scheme). Cover numbering with a concurrency test.

> This lets the modules be fully independent in workflow and UI while the one thing that must stay unified
> — the job number — is owned by a single service.

---

## 7. Visualization subsystem

Graphics are a major, and currently fragile, part of delivery. NZI Console treats visualization as a
**first-class shared subsystem**, specified in full in **`GRAPHICS_PIPELINE.md`**. In brief:

- **One SVG-first chart engine** (`@nzi/charts`) renders a single declarative chart spec **identically to
  the console screen, the PDF and the client portal** — replacing the live platform's three rendering
  stacks (matplotlib + Plotly/Kaleido + human-captured browser PNGs) and removing the runtime headless-
  browser provisioning that breaks after deploys.
- **Charts are derived from reviewed data, never captured.** No human "capture" step; a
  **content-addressed** cache (keyed by data + spec + tokens hash) makes staleness structurally
  impossible — directly fixing the live `job_widget_pngs` stale/missing-image failures.
- **The report manifest is the only assembly path, with validation as a hard publish gate** — adopting and
  *wiring in* the `report_manifests` / `report_manifest_validation` layer the live platform built but left
  disconnected, so nothing publishes with a missing or stale chart.
- **Every chart carries provenance** (job data, factor set/version, spec version) and expands in the
  evidence drawer like a scope row.
- **Shared engine, per-family catalogues:** each job family (§6) declares its own manifest and chart subset
  but renders through this one subsystem — separation of modules must not become separation of graphics
  stacks (the trap the live system fell into).

---

## 8. Frontend architecture

- **Stack:** Next.js (App Router) + React + TypeScript; `@nzi/ui` design system; `@nzi/mock-data` today.
  Inter type, emerald tokens, the locked shell.
- **Composition:** route-level screens per workspace; shared primitives promoted into `@nzi/ui` as they
  stabilise (the scaffold's stated pattern). Page-local pieces (scope table, drawer form) graduate into
  `@nzi/ui` once proven.
- **State & data (when wired):** a **typed API client** with response validation; **TanStack Query** with
  per-resource queries and targeted invalidation; URL-persisted list filters (survive refresh);
  action-level pending states (not one global spinner); section-specific skeleton / empty / degraded /
  error states.
- **Accessibility:** persistent form labels, keyboard operation, status announcements; usable with the
  rail collapsed and on supported mobile layouts (as FuelCap's DEC-008 visual gate enforced).

---

## 9. Backend architecture (target, for the wired-but-isolated phase)

The console does **not** re-implement the NZI Pro backend. When it moves off mock data it talks to a
**thin, typed, isolated** API in front of canonical NZI Pro domain services — never directly to the
production database.

```
Next.js screens + @nzi/ui
        │  typed API client (validated)
        ▼
Isolated console API (typed contracts, authz, tenant scoping)
        │
   application services ── audit ── canonical Client/Quote/Job/Report services
        │
   repositories (tenant-scoped) ── explicit transactions ── idempotency
        │
   versioned Postgres (non-prod) + RLS      background workers (prospecting, PDF)
```

Rules (from §2, enforced): typed resource + command endpoints (not arbitrary dict patches); structured
Problem-Details errors with correlation IDs (invalid transition → 4xx, version conflict → 409, **never
200+warning**); one explicit transaction per command; external/long work (PDF render, prospecting) off
the request path via workers; every mutation audited; migration-owned schema.

---

## 10. Integration & isolation boundary

| System | Boundary |
|---|---|
| **NZI Pro production DB** | Never touched by the console. No production credentials in this repo/service. |
| **Non-prod Supabase/Postgres** | Introduced only when moving from mock to wired-but-isolated; seeded with anonymised/synthetic data. |
| **Canonical Client/Quote/Job/Report** | Reused as services behind the isolated API — the source of truth for those domains. |
| **Xero / Stripe** | Test-mode / sandbox only during redesign; live wiring is a later, separately-approved step. |
| **AI providers (OpenAI/Gemini/Apollo/Companies House)** | Grounded, permissioned, quota-controlled; approved per provider before any production use. |

`NEXT_PUBLIC_APP_ENV=staging` is the authoritative in-app "this is not production" signal.

---

## 11. Delivery phases

Ordered increments (calendar estimates set after the model and integration choices are approved),
mirroring the FuelCap phase discipline.

- **Phase 0 — Design-first console (current).** Mock-data screens prove the shell, evidence drawer, and
  the flagship Job workflow. Exit: Control Room + Jobs + Clients green on mock data, deployed isolated,
  no production references. *(Largely done.)*
- **Phase 1 — Model & IA breadth on mock data.** Build the remaining workspaces as evidence-led screens
  on mock data: Emissions, Datasets & factors, Reports, LCA, Sales, Platform & audit, and the Portal
  surface. Promote stable primitives into `@nzi/ui`. **Stand up `@nzi/charts` (SVG-first, screen+print
  parity on mock data) and the per-family job modules over the shared spine + numbering service (§6–§7).**
  Exit: every workspace navigable and internally consistent on one mock dataset; a rehearsed click-through
  of the canonical CRP journey (§15 of `WORKFLOWS.md`); the CRP report renders from a manifest with the
  validation gate active (still mock).
- **Phase 2 — Contracts & typed API client.** Define typed contracts for each screen (lists, detail,
  commands) against the domain model; wire the API client with validation and the five UI states, still
  against mock/fixture responses. Exit: contract tests green; no screen depends on an untyped fetch.
- **Phase 3 — Wired-but-isolated.** Stand up the non-prod backend + isolated DB; connect read paths, then
  guarded write paths, reusing canonical services with explicit transactions, idempotency, tenant RLS and
  audit. Exit: two-tenant isolation suite passes; the CRP journey runs end-to-end on isolated data;
  forced-failure rollback verified.
- **Phase 4 — Sales V2 & family workflows.** Deliver the Sales V2 lifecycle and the explicit
  job-family/stage model on the isolated backend. Exit: Prospect→Lead→Opportunity→Client/Quote→Job runs
  once-and-only-once; families carry correct detail + stage history.
- **Phase 5 — Pilot & cutover planning.** Internal pilot, reliability/accessibility gates, rollback and
  reconciliation plan. Cutover only after gates pass and named owners approve.

---

## 12. Non-goals (for now)

- No changes to the live NZI Pro platform, its database, or the FuelCap services.
- No production credentials or real client PII in this repo or service.
- Not a full marketing-automation / outbound suite (Sales stays a lightweight internal operating layer).
- No re-implementation of canonical Client/Quote/Job/Report SQL.
- No request-time schema creation, ever.

---

## 13. Open decisions

Tracked and resolved in `DECISIONS.md`. The canonical scope-row model is now **confirmed as
`job_scope_rows`**, with `crp_scope_entries` treated as legacy migration input. The isolated-backend data
strategy is also confirmed: synthetic by default, with a formally vetted anonymised subset allowed only
for restricted migration and compatibility testing. Reporting will be rebuilt natively in the isolated
platform, using manifest-driven assembly and the shared SVG-first chart subsystem, while retaining the
live reports as business-content compatibility references. The remaining high-impact items include the
job-family + workflow-stage schema and **per-family module
boundaries** (NZC-024); the shared official `J000612` job-numbering format and gap policy (NZC-025); the
**single chart engine and SVG-first rendering** (NZC-026–NZC-029, detailed in
`GRAPHICS_PIPELINE.md`); and Sales V2 terminology and lifecycle. The role set and permission model are
confirmed in NZC-022, with the capability-level matrix intentionally refined as each workspace is
designed. The four formerly Open decisions (NZC-008, NZC-020, NZC-021 and NZC-022) are now resolved; see
`DECISIONS.md` for their confirmed outcomes.
