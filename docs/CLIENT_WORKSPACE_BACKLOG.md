# Client Workspace — complete build backlog

The full set of things to develop into the redesigned **client workspace** (the single
client record + its area sub-nav), reconciled against the *live* NZI Pro client functions
in `WORKFLOWS.md` (§3 client management, §5 reporting/actions/SRS, §7 review→portal, §9
commercial, §10 CRM).

**Status:** `Built` = in the locked prototype · `Partial` = present but shallow/placeholder ·
`To build` = not yet designed/built.
**Tier:** `Go-live` = parity- or trust-critical, blocks go-live · `Should` = expected by
users migrating from the live system · `Stage 2` = deferrable.

## Build status snapshot (13 Sep 2026)
- **Merged to `main` / live:** provenance (#144), site effective-dating + floor area,
  contact roles + logo + year-end, permission matrix, target model (#145), breadcrumbs,
  the shell rebuild Phase 1 (#146/#147) **and Phase 2** (`b696421`), and #143 (NZC-069 held).
- **SRS Readiness — landed:** **PR #149 merged** (`2a47bc8`, migration `0070` on `main`) —
  versioned framework, dated assessments, dashboard.
- **Both landed since:** intensity metrics (#150) and the action-lever library (#153,
  renamed to `control_level` by `d37e409` / migration 0076).
- **Designed + briefed, impl to build:** report (R-track) — prototype `report_v1.html` +
  `_handoff_REPORT_brief.md`; the **print-safe icon-set decision is settled** (curated inline
  SVG, in DESIGN_CONVENTIONS §10) which also unblocks the intensity/action report icons.
- **Reduction Strategies notifications — done (14 Sep 2026):** in-app + portal deadline signals
  (#164) and **email reminders (#165, migration `0083`) — live and verified on staging**: worker
  `nzi-console-reminders` drained the outbox backlog as skipped × 42, sent 0, failed 0; staging is
  suppress-and-log and cannot send (NZC-076). **Two production gates intentionally open:**
  (a) consent capture (§B), (b) live worker standup against the live boundary + real SMTP (§G).
- **Held:** commercial ledger (NZC-069 held).
- **Job families:** shared spine + numbering done; models `0045`–`0050` done; LCA/PCF staff
  module built (L1–L7). Remaining staff modules: Training, Consultancy (follow LCA pattern,
  `MODEL_FIDELITY_JOB_FAMILIES.md` §7). **Client-portal family display** designed +
  briefed — prototype `portal_projects_v1.html` + `_handoff_JOB_FAMILIES_PORTAL_brief.md`.
- **Training family (largest):** designed + briefed — three surfaces + entitlements.
  Prototypes `job_training_v1.html` (staff run: stage machine, sessions, booking register,
  attendance, certificate issuance, entitlement places), `portal_trainee_v1.html` (new
  `trainee_auth` realm — person-centric, portable), `portal_training_v1.html` (client-portal
  training tab — staff record + places yet-to-take/expiry + skills matrix). Design note
  `TRAINING_WORKFLOW_REVIEW.md` + brief `_handoff_TRAINING_brief.md`. **4 decisions open**
  (person-centric identity, who books places, verifiable certificates now vs Stage 2, email
  re-verification on leave). **All 4 decisions confirmed 13 Sep 2026:** person-centric identity;
  consultant/CRM books places; verifiable certificates build now; re-verify email + drop former
  employer's view of new personal details. Load-bearing: `trainees` record + `trainee_auth` first.

Prototype it reconciles against: Client Workspace artifact (v5).

---

## A. Client record & Overview

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Header: name, status pill, sector, location, account owner, client no. | `clients` | Built | — |
| **Logo upload & display** (currently a monogram) | `/clients/logo-upload`, SharePoint-aware | To build | Go-live |
| **Year-end month** (drives the 300–400 day reporting-year eligibility rule) | `clients` | Partial | Go-live |
| Firmographics: company reg no., website, HQ | `clients` | Partial | Should |
| **Portfolio grouping** | `portfolios_lookup` | To build | Should |
| Client status lifecycle edit (Active/Prospect/…) | `clients.status` | Partial | Should |
| Setup progress / data completeness | `client_dashboard` `data-completeness` | Built | — |
| Active jobs & milestone progress | `/clients/{id}/jobs` | Built | — |
| Create job / new engagement | `jobs` | Built | — |

## B. Contacts

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Contact CRUD via drawer | `/clients/{id}/contacts` | Built | — |
| Primary contact designation | `client_contacts` | Built | — |
| **Contact roles**: report signee · portal candidate · quote/invoice recipient · training attendee | `client_contacts` | To build | Go-live |
| Deactivate-not-delete | principle | To build | Go-live |
| **Email consent capture** — an audited way to set `client_contacts.email_consent` (`unknown` → `granted` / `declined`), with reason and history. Production gate (a) for strategy reminder email: `unknown` holds, so no contact can be written to until this exists | NZC-076 · migration `0083` (column only) | **To build — intentionally open gate** | Should |

## C. Sites

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Site add/edit via drawer | `/clients/{id}/sites` | Built | — |
| Geocode (optional lat/long + lookup) | `services/geocoding.py` | Built | — |
| **Mark registered office** | `client_sites` | Prototype ✓ · impl Partial | Go-live |
| **Vacate site (effective-dated close)** — changes reporting boundary & per-m² denominator | `client_sites` (effective-dated) | Prototype ✓ · impl Partial (boundary bugs) | Go-live |
| **Site floor area (effective-dated)** — the real per-m² denominator | new decision (NZC-###) | Prototype ✓ · impl To build | Go-live |
| Sites map view | portal `sites-geo` | To build | Should |

## D. Baseline & targets

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Baseline record + re-baseline/recalculate governed drawer + history timeline | `MODEL_FIDELITY_BASELINE.md`, `client_baselines` | Built | — |
| Significance threshold on recalculation (NZC-068) | decision | Built (design) | — |
| **Forward target model**: net-zero year, interim year, per-scope target year+pct, benchmark year — feeds the pathway | `client_targets` (0069), versioned | Prototype ✓ · impl PR #145 | Go-live |

## E. Carbon Analytics

| Item | Live reference | Status | Tier |
|---|---|---|---|
| YoY emissions by scope (stacked) | `@nzi/charts` | Built | — |
| Scope split donut + reporting-year picker | `job_report` | Built | — |
| Emissions intensity — multi-base (revenue / FTE / m²) + **All (indexed)** | job business metrics | Built | — |
| Reduction pathway to net zero | `@nzi/charts` | Built | — |
| **Evidence/provenance drawer per figure** (factor set + version + data hash + as-at) | evidence-drawer-first principle | Prototype ✓ · impl Partial (not wired; provenance invented) | Go-live |
| **Distinct empty / loading / degraded / failed states** (never failed-as-zero) | fail-open fix | To build | Go-live |
| Extensible intensity-base registry (add more denominators) | — | To build | Should |

## F. Reporting

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Report list — per-report open, version, PDF, immutable published versions | `job_report`, `report_template` | Built | — |
| Report Studio (R-track): template assignment, per-job variable capture, version snapshots | `report_template`, `report_actions` | To build | Go-live (view) / Should (edit) |
| Emissions certificate output | `job_emissions_certificate` | To build | Should |
| PDF / DOCX paged output | `job_report_pdf`, `job_report_docx`, R5 track | To build | Should |
| Methodology statement | `methodology` | To build | Stage 2 |

## G. Actions — carbon-reduction plan  *(incorporate live detail)*

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Action tracker (levers with progress) | portal `actions` A2-lite | Built — #119 (qualitative) | — |
| **Action lever library / catalogue** | `report_actions_routes`, `action_lever_framework` (0064), Admin → Action options | **Built — #153** (Admin catalogue; brief `_handoff_ACTION_LEVER_LIBRARY_brief.md`) | Go-live |
| Assign actions per client from library + **lever summary** | `/clients/{id}/report-actions`, `action-lever-summary` | **Built — #153** (client plan + lever summary) | Should |
| Spheres-of-Influence framework mapping | framework | Built — `d37e409` (renamed `sphere_of_influence` → `control_level`, migration 0076) | Should |
| Action status / owner / target dates | `report_actions` | Built — #158, Reduction Strategies (NZC-075) | Should |
| **Strategy → SRS alignment + `include_in_report`, and the plan the report prints** | `strategy_srs_requirements` (0081) | **Built — #162** (alignment confirmed on library add, #163) | Should |
| Drawer anatomy — strategy drawers match the scope-row side panel | DESIGN_CONVENTIONS §3.4 | **Built — #169** (no migration) | — |
| **Deadline signals — in-app + portal** (approaching / overdue, derived at read time; no date raises nothing) | brief §6 | **Built — #164** (no migration) | Should |
| **Deadline email reminders** — worker `nzi-console-reminders` drains the outbox on a 900 s clock; Office 365 SMTP; claim-before-send idempotency (`strategy_automation_log`) | brief §6a · NZC-076 | **Built — #165 / migration `0083` · verified on staging 14 Sep 2026** (first tick: outbox backlog skipped × 42, sent 0, failed 0; log 0 rows — no reminder has run yet (no client strategies on staging); reminder path proven by CI, not by a staging run). Staging is suppress-and-log and cannot send. | Should |
| ↳ Production gate (b): **live worker standup** against the live DB boundary + real SMTP | NZC-076 | **Intentionally open** — a separate reviewed deploy, *and* a reviewed change to the worker's start-up guard, which by design refuses the live boundary today | Should |
| Quantified emissions projection from actions | (live has none) | To build | Stage 2 |

## H. SRS Readiness  *(incorporate live detail)*

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Readiness summary (overall %, governance, metrics & targets) | `srs_readiness` | Built (illustrative) | — |
| **SRS Readiness redesign** — assessment + demo graphics | `srs_readiness_routes` (0065) | **Built — #149** (`2a47bc8`, migration `0070` on `main`); charts `SrsPillarRadar` / `SrsMaturityBullets` / `SrsGapHeatmap` / `SrsReadinessTrend` | Should (commercial) |
| Framework definition (standards/pillars/requirements/weights), Admin-versioned | Admin → SRS readiness | **Built — #149** (versioned framework + requirements, migration `0070`) | Should |
| Portal surfacing of readiness (read-only, M6.4) | portal `srs-readiness` | Briefed | Stage 2 |

## I. CRM — Tasks / Notes / Communications / Timeline

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Tasks: client-scoped to-dos, owner, due, open-count | `clients/{id}/tasks` | Partial | Should |
| Notes | `client_notes` | Partial | Should |
| **CRM timeline**: tagged interaction / touchpoint events | `crm_timeline_routes` | To build | Should |
| Communications log (emails, etc.) | `crm_timeline` | Partial | Should |
| Touchpoints + health snapshots (relationship intelligence) | `client_touchpoints`, `client_health_snapshots` | To build | Stage 2 |
| Call-prep view | `intelligence_routes` | To build | Stage 2 |
| CRM automation rules | `crm_automation_routes` | To build | Stage 2 |

## J. Files

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Client files list + upload | `client_files`, SharePoint-served | To build (placeholder) | Should |

## K. Company Profile

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Firmographics, group structure, frameworks, certifications, primary Scope 3 | `clients` | Built (display) | — |
| Addresses (registered / billing) + geocode | `clients` | Built | — |
| Client factors (custom factors, EPD evidence, versioned, archived) | `custom_factors`, S2 | Built (manager) | — |
| Fully editable via drawers | — | Partial | Should |

## L. Financials — commercial

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Quotes table + **full versioned history drawer** | `/clients/{id}/quotes` | Prototype ✓ · impl under review (NZC-069) | — |
| **Quote lifecycle**: create · approve · accept · revise (versioned) · email | `quotes` routes | Prototype ✓ · impl under review | Should |
| Invoices table + **history drawer** | `jobs/{id}/line-items` | Prototype ✓ · impl under review | Should |
| Invoice line-items + templates (`apply-template`, `create-invoice`) | invoice routes | Prototype ✓ · impl under review | Should |
| **Credit notes** (at invoice/job/client level) | `credit_notes_routes` | Prototype ✓ · impl under review | Should |
| Xero projection boundary (what lives here vs Xero) | BD brief | **Decided**: console is source-of-record; Xero mirrors. ⚠️ impl hard-codes `xeroStatus:"connected"` — must be derived (truth-before-availability) | — |

## M. Portal (client access administration)

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Portal access button + link into the client's portal | `platform` | Built | — |
| **Portal plan view** — the client-facing **live** Reduction Strategies plan on the portal (grouped by lever, `include_in_report` only, read-only). Distinct from the deadline *signals* in #164, which are counts + exceptions only (`PortalStrategiesReadModel`) | §G plan · `getPortalClientStrategies` | **To build — briefed** (`docs/_handoff_PORTAL_PLAN_VIEW_brief.md`) | Should |
| **Portal user administration**: candidate users, create/patch, reset password, reset MFA, resend invite | `portal-candidate-users`, `portal-users` | To build | Go-live |
| **Portal-jobs**: which jobs a client can see | `portal-jobs`, `portal-access` | To build | Should |
| **Data-entry expiry windows** (time-boxed client data entry) | `jobs/{id}/portal-data-entry-expiry` | To build | Should |
| Staff "enter client portal context" (support/preview) | `portal/auth/staff-select-client` | To build | Stage 2 |

## N. AI Profile

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Grounded AI context (company description, sector, material Scope 3), versioned, advisory-only, separated from evidence base | report narrative grounding | Partial (placeholder) | Should |

---

## Cross-cutting (apply across the whole workspace)

| Item | Source | Status | Tier |
|---|---|---|---|
| Evidence-drawer-first provenance on every number | ARCHITECTURE / conventions | To build | Go-live |
| Permission matrix / role gating (Financials, portal admin, re-baseline) | NZC-022 (open) | To build | Go-live |
| Distinct empty / loading / degraded / failed states | fail-open fix | To build | Go-live |
| Audit trail on every client mutation (permission-checked command + audit event) | governed spine | To build | Go-live |
| Deactivate-not-delete (contacts, sites, factors) | governed spine | To build | Go-live |
| Accessibility — shared primitives + a11y acceptance | `ACCEPTANCE_A11Y_SHARED_PRIMITIVES.md` | Ongoing | Go-live |

---

## Go-live shortlist (the blocking set)

1. Evidence/provenance drawer on figures (E) — prototyped; **impl Partial** (see audit — not wired, provenance invented, no real states)
2. Site effective-dating: registered office + vacate (C) — prototyped; **impl Partial** (see audit — page not wired, boundary bugs, floor area missing)
3. Forward target model feeding the pathway (D)
4. Contact roles (B)
5. Permission gating (cross-cutting)
6. Distinct data states, never failed-as-zero (cross-cutting)
7. Action lever library assignment (G) — prototyped + briefed
8. Portal user administration (M)
9. Logo + year-end month (A)

Items 1 and 2 have prototypes and a first (rejected) implementation; a **corrective build
brief** is in flight — see the audit for the gap list. Commercial history (L) is prototyped
but its implementation is **under review** (bundled into the same commit; false Xero status).
Remaining go-live items 3–9 are still to design/build.

### Decisions taken during the corrective pass
- **Reporting-period basis = financial year.** The site boundary and every figure resolve
  against the job's reporting period via `resolveBaseline()`, never the calendar year.
- **Legacy site backfill:** existing/legacy sites get `in_service_from = NULL` (open lower
  bound = "in service from before records"), never the migration date and never a guessed
  earliest-job date. New sites default to the job's reporting-period start, editable.
- **Site floor area** (new decision): effective-dated `floor_area_m2` per site; the per-m²
  denominator = sum of in-boundary sites' floor area for the reporting year; a site missing
  floor area makes per-m² "unavailable" for that year, never a wrong number.
- **Vacate meaning:** `vacated_effective` = first day OUT of service; boundary uses strict `>`.
- **One registered office per client**, enforced; a vacated site can't be registered;
  vacating a registered office blocks until reassigned.

### Round 2 — gaps found in the second review (decisions + work)
- **Historical snapshots keep provenance without re-issue.** *(Confirmed.)* A published
  report is immutable, so existing snapshots are NOT re-issued. Backfill a provenance stamp
  marked `source = migrated_unverified` (the NZC-065 pattern) recording the factor set /
  version / hash / as-at that was in effect; new issues carry a real, resolved stamp.
  **The published PDF must remain retrievable regardless of provenance-stamp status** — a
  missing or `migrated_unverified` stamp never blocks access to the issued PDF.
- **Commercial ledger / Xero (NZC-069): HELD** — to be picked up in a dedicated
  quotes/invoices exercise. Split onto its own branch with honest Xero status now; do not
  merge until revisited.

### ⭐ Client workspace shell rebuild (the piece that makes Render match v10)
Every prior brief added a *feature* onto the existing `page.tsx`; the page shell/IA was
never rebuilt, so the deployed client page is the old two-tab layout with new bits grafted
on. The **shell rebuild** commissions the v10 IA — the left area sub-nav, setup-progress
strip, top-pinned Active-jobs card with the rest collapsible, drawer-based editing
throughout, Carbon Analytics on `@nzi/charts` — into which the built features slot.
Phase 1: shell + Overview + Carbon Analytics + drawers (retire the separate /edit page).
Phase 2: the remaining areas (Reporting, Actions, SRS, Tasks, Notes, Files, Comms, Company
Profile, AI Profile; Financials shows the HELD state). Depends on #142 + #145 merged.
Status: **Phase 1 (#146 + #147, `adae870`) AND Phase 2 (`b696421`) MERGED to `main`; #143
(NZC-069 held docs) merged (`f85e168`).** Breadcrumbs (full, linkable, per DESIGN_CONVENTIONS
§3.1) merged with Phase 1. All acceptance items met; PRESERVE items test-pinned. Shell
rebuild is **complete and live on Render**.

### Follow-ups from the target-model review (PR #145)
- **#137 must finish the v10 Baseline & targets card** — the dated baseline record, its
  figures and the history timeline (the baseline *half* of the card). PR #145 built only
  the targets half and shows the baseline in force as a single line.
- **Report engine pathway → client target model (for NEW issues only).** Issued reports
  are frozen evidence and stay as-is, but the report chart's job-level target assumes
  net zero = 0, which is *wrong* (net zero carries a residual — the client model gets this
  right). New report issues must adopt the client target model; do it before the next
  reporting cycle so fresh reports don't bake in the zero-residual error.
- **Benchmark seam** flips from the client-record baseline fields to the `client_baselines`
  dated record when #137 lands — one function, source-stamped, no downstream change.

### Target-model judgement calls (all confirmed)
Benchmark seam (single source-stamped fn) · baseline card half deferred to #137 · frozen
reports untouched (engine unified for new issues as a follow-up) · `client_targets` as a
versioned table not columns — required for audit + the NZC-068 hold.
- **NZC-066 completion:** every report issue records the baseline it was issued against
  (baseline-ref stamped at issue time); existing issues backfilled `migrated_unverified`
  where derivable, else flagged. Currently missing.
- **/clients list must resolve, not seed.** The list shows the resolved latest-issued
  emissions + as-at from the snapshot, or "Not reported" — never a seeded footprint/YoY.
- **Job running total = in-boundary total.** Out-of-boundary rows are excluded from the
  headline total and surfaced as gaps with a visible "N rows excluded — resolve"
  affordance; they are never silently counted (truth before availability).
- **Unknown client = HTTP 404.** `notFound()` must not be swallowed to a 200 by the new
  loading state.
- **Permission names belong in the matrix.** `finance.manage` (and any others) must be
  defined in the NZC-022 permission matrix, not invented ad hoc — NZC-022 is still open.
