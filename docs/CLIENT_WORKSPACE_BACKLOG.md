# Client Workspace — complete build backlog

The full set of things to develop into the redesigned **client workspace** (the single
client record + its area sub-nav), reconciled against the *live* NZI Pro client functions
in `WORKFLOWS.md` (§3 client management, §5 reporting/actions/SRS, §7 review→portal, §9
commercial, §10 CRM).

**Status:** `Built` = in the locked prototype · `Partial` = present but shallow/placeholder ·
`To build` = not yet designed/built.
**Tier:** `Go-live` = parity- or trust-critical, blocks go-live · `Should` = expected by
users migrating from the live system · `Stage 2` = deferrable.

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
| **Forward target model**: net-zero year, interim year, per-scope target year+pct, benchmark year — feeds the pathway | `clients` target fields | Partial | Go-live |

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
| Action tracker (levers with progress) | portal `actions` A2-lite | Built (qualitative) | — |
| **Action lever library / catalogue** | `report_actions_routes`, `action_lever_framework` (0064), Admin → Action options | To build | Go-live |
| Assign actions per client from library + **lever summary** | `/clients/{id}/report-actions`, `action-lever-summary` | To build | Should |
| Spheres-of-Influence framework mapping | framework | To build | Should |
| Action status / owner / target dates | `report_actions` | Partial | Should |
| Quantified emissions projection from actions | (live has none) | To build | Stage 2 |

## H. SRS Readiness  *(incorporate live detail)*

| Item | Live reference | Status | Tier |
|---|---|---|---|
| Readiness summary (overall %, governance, metrics & targets) | `srs_readiness` | Built (illustrative) | — |
| **Full SRS readiness questionnaire per client** | `srs_readiness_routes` (0065) | To build | Should |
| Framework definition driving the questionnaire | Admin → SRS readiness | To build | Should |
| Portal surfacing of readiness (M6.4) | portal `srs-readiness` | To build | Stage 2 |

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
7. Action lever library assignment (G)
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
