# NZI Console development plan

**Delivery model:** milestone-based, evidence-led, and continuously deployed to the isolated staging service. Each milestone has a definition of done. Work is grouped into coherent batches; a green build alone does not complete a milestone.

## Current programme

| Milestone | Status | Definition of done |
|---|---|---|
| M1. Client portal | In progress | A client can enrol, authenticate, see only granted work, review immutable publications, collaborate, manage security, provide authorised data, obtain deliverables, and complete all critical journeys accessibly on desktop and mobile. |
| M2. Core CRP workflow | Implemented; browser acceptance pending | Staff can configure a CRP job, collect activity data, resolve factors, inspect lineage, complete QA, freeze a snapshot, validate and publish it with a complete audit trail. |
| M3. Staff workspaces | Implemented; browser acceptance pending | Clients, Jobs, Datasets, Reports, and Platform workspaces support their canonical operational workflows with explicit states and permissions. |
| M4. Additional services | Planned | LCA/PCF, Consultancy, Training, and Sales V2 use the shared job spine while preserving their distinct domain models. |
| M5. Production readiness | Planned | Security, tenancy, accessibility, performance, observability, backup, rollback, and controlled release gates are independently verified. |

## M1. Client portal baseline — 27 August 2026

### Complete and evidenced

- [x] Independent portal principal, session cookie, password login, and MFA challenge.
- [x] Governed invitation setup with password and authenticator enrolment.
- [x] Staff-managed portal users, job-level grants, revocation, and invitation state.
- [x] Authenticated identity and granted-job portfolio with explicit loading, empty, failed, and success states.
- [x] Immutable published-report screen and print/PDF surface derived from one reviewed snapshot.
- [x] Evidence hash, manifest, snapshot, measurement, target, intensity, and comparison validation.
- [x] Version-bound client approval with immutable approval evidence.
- [x] Version-bound client/staff review thread and read receipts.
- [x] Authenticated password change with other-session revocation.
- [x] Server and browser validation share the same portal evidence contracts.
- [x] Automatic staging deployment and authenticated health verification after each accepted batch.
- [x] Authenticated staff password change with current-password verification, preserved MFA, and other-session revocation.

### Remaining acceptance batches

#### P1. Automated portal contract and journey tests

- [x] Add executable tests for portal identity, portfolio, publication, approval, comment, and read-receipt contracts.
- [x] Cover valid, malformed, cross-job/cross-version, duplicate, and contradictory evidence.
- [x] Add authentication, invitation, approval, messaging, and password-change integration journeys.
- [x] Make the portal test suite part of the standard verification command (`npm run test:portal`).

#### P2. Recovery and session experience

- [x] Keep recovery staff-governed until a verified outbound-email/reset-token service exists; document the client-safe recovery route.
- [x] Provide a complete governed recovery path from sign-in guidance through staff-issued, single-use re-enrolment; immediately revoke sessions and suspend old credentials.
- [x] Handle expired/revoked sessions consistently across pages and mutations, clearing stale cookies before sign-in to prevent redirect loops.
- [x] Verify logout, session rotation, 15-minute password lockout, post-lockout retry, exhausted/expired MFA challenges, and governed MFA recovery behaviour.

#### P3. Constrained client data entry

- [x] Implement tenant/client/job-bound data-entry grants and ordered expiry windows, with audited staff scheduling and authoritative client states.
- [x] Render only canonical scope-row buckets with job-selected factors, client-owned sites, and factor-derived units authorised by staff.
- [x] Support client create/edit/soft-delete/submit with optimistic concurrency, stale-version recovery, and portal audit evidence.
- [x] Route submitted data into the staff review queue; never treat client entry as reviewed emissions.
- [x] Cover manual activity, spend, commuting, and vehicle entry according to the canonical scope-row model.

#### P4. Deliverables and document records

- [x] Expose version-bound report PDF, certificate, and methodology deliverables.
- [x] Verify file identity, content type, version, access grant, and download failure states.
- [x] Keep screen, print, and downloadable evidence aligned to the same publication.

#### P5. Portal acceptance gate

- [ ] Keyboard, focus, screen-reader, contrast, and reduced-motion review.
  - Automated foundation complete: shared skip navigation, visible focus, ARIA tab semantics and keyboard movement, contrast-safe primary controls, reduced-motion enforcement, and executable source contracts.
  - Rendered axe-core WCAG 2.1 A/AA scan now runs against deployed staging on every route (`apps/console/tests/e2e/accessibility.spec.ts`); two markup defects fixed, contrast findings catalogued for a design-token pass (`axe-baseline.json`).
  - Remaining acceptance evidence: the manual assistive-technology narration pass in `docs/RENDERED_ACCEPTANCE_CHECKLIST.md` §2.
- [ ] Responsive verification at phone, tablet, laptop, and wide desktop widths.
  - Automated layout foundation complete for wide, laptop, tablet, phone, and narrow-phone breakpoints across portal home, authentication, reports, data-entry forms, documents, and account security.
  - Rendered viewport captures + no-horizontal-overflow assertions at 390/768/1280/1920 now run against deployed staging (`apps/console/tests/e2e/responsive.spec.ts`).
  - Remaining acceptance evidence: visual review of the captured screenshots at each breakpoint.
- [ ] Browser journey tests for enrolment through report approval and data submission.
  - Playwright suite delivered (`apps/console/tests/e2e/`): real staff + portal login (password + TOTP), staff-workspace render, CRP workspace render, portal portfolio → published report. Run with `npm run test:e2e` after `npm run acceptance:provision` against isolated staging.
  - Remaining: execute the run with provisioned accounts and attach the report to the acceptance record; add the write-path journeys (submit → approve, configure → publish).
- [x] Permission, cross-client isolation, CSRF/origin, rate-limit, and stale-session tests.
  - Acceptance coverage inventories every portal mutation route and requires the shared same-origin guard.
  - Tenant-bound session resolution, durable password/MFA throttling, and non-cacheable stale-session expiry are regression protected alongside the functional backend tests.
- [x] Staging acceptance record with known limitations and rollback check.
  - Evidence, open browser-only checks, and the verified rollback path are recorded in `docs/STAGING_ACCEPTANCE_M1.md`.

## M2. Core CRP workflow

### C1. Canonical evidence and calculation

- [x] Tenant-bound CRP jobs, reporting periods, sites, purchased-goods categories, datasets, targets, and intensity configuration.
- [x] Versioned scope-row creation and editing with governed factor selection.
- [x] Deterministic calculation with provenance and expandable lineage.

### C2. Independent assurance and evidence freeze

- [x] Approval and rejection decisions bound to exact row versions.
- [x] Explicit QA readiness derived from enabled calculations, quality evidence, and independent decisions.
- [x] Content-addressed reviewed snapshots that reject incomplete or stale evidence.

### C3. Governed publication

- [x] Shared manifest validation and immutable report-version persistence.
- [x] Exact-version publication with prior published versions superseded atomically.
- [x] Live staff controls joining the latest reviewed snapshot to validation and portal publication.

### C4. CRP lifecycle acceptance

- [x] Executable assured-release journey from complete reviewed evidence through immutable portal publication, including audit and outbox evidence.
- [x] Negative release journeys for incomplete QA, mismatched snapshot evidence, and repeat publication.
- [x] One executable journey covering job configuration through immutable publication.
- [x] Upstream negative journeys for stale job and scope-row versions.
- [x] Staging acceptance record for the complete staff CRP workflow.
  - Automated evidence, browser-observation limitations, and rollback are recorded in `docs/STAGING_ACCEPTANCE_M2.md`.

## M3. Staff workspaces

### S1. Reports workspace

- [x] Live tenant-bound publication register with immutable version and client-review state.
- [x] Live immutable report detail resolved from its exact reviewed snapshot, data hash, and manifest.
- [x] Replace fixture template and preview surfaces with the code-governed manifest and tenant-bound reviewed snapshots.

### S2. Clients and Jobs workspaces

- [x] Complete canonical client detail, primary contact, tenant-owned sites, and workflow relationship history.
- [x] Complete cross-family job index and operational stage controls without fixture fallbacks.

### S3. Datasets and Platform workspaces

- [x] Replace fixture dataset administration with tenant-bound version, provenance, licence, geography, usage, and exception controls.
- [x] Complete live audit, enforced permission matrix, membership counts, authenticated application health, and tenant-database governance views.

### S4. Staff workspace acceptance

- [x] Automated role, tenant, live-boundary, failure-state, keyboard-foundation, and responsive-contract journeys across every staff workspace.
- [ ] Responsive, keyboard, failure-state, and staging acceptance evidence.
  - Automated and staging evidence is recorded in `docs/STAGING_ACCEPTANCE_M3.md`.
  - Rendered evidence now automated via the Playwright suite (`apps/console/tests/e2e/` — staff-workspace render, axe scan, viewport captures against deployed staging); remaining is the manual assistive-technology pass (`docs/RENDERED_ACCEPTANCE_CHECKLIST.md`).

## Data-entry redesign — typed capture adapters (NZC-035)

Sequenced by `docs/REDESIGN_ROLLOUT.md`. Each adapter ships behind
`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` (OFF by default), generic path untouched, and does not flip on until it
passes its own rendered acceptance.

- [x] **Phase 0** — additive model/schema (NZC-041–045; migrations 0034–0037) merged; applied to staging.
- [x] **B1** — kind-specific capture fields (commuting / vehicle / spend) in the emission-source register.
- [x] **B2 — spend ledger adapter (Phase 2 vertical slice).** CRP-side, flagged. Paste ledger → advisory PG&S
  category + factor per line → Scope 3.1 sources synced with the Spend-based quality tier (+ controlled PG&S
  category, monthly split by invoice month, stable evidence hash) through the unchanged spine. No sites
  (NZC-042 not touched). Acceptance in `docs/STAGING_ACCEPTANCE_B2.md`; **flag flipped 31 Aug 2026 (PR #17)**.
  Deferrals tracked: #18/#19 (B3), #20/#21 (B4), #22 (human-only AT pass).
- [ ] **B3 — previous-year rollforward** (next). Re-pins prior factor versions (NZC-030); brings the
  prior-year data the YoY variance flag needs (#18, #19). Behind the same flag, its own acceptance gate.
- [ ] B4 Excel/CSV preflight import (NZC-036; #20, #21) · B5 constrained portal mirror.
- [ ] Phase 3 — remaining adapters + stage-as-section (NZC-038); Phase 4 — retire the generic path.

## Delivery rules

1. Work the active milestone from top to bottom unless a discovered security or data-integrity defect requires immediate containment.
2. Each batch must include implementation, proportionate automated tests, production build, workspace type checks, diff checks, deployment, and staging verification.
3. Progress reports name the milestone, completed batch, overall status, and next batch.
4. New scope is placed into the plan before implementation; “continue” advances the next unchecked batch.
5. Production remains out of scope until M5 is complete and explicitly authorised.

## Immediate next action

Execute the combined **M1, M2, and M3 rendered acceptance pass**. The automated half is
delivered (`docs/RENDERED_ACCEPTANCE_CHECKLIST.md`, `apps/console/tests/e2e/`). Remaining:
run `npm run acceptance:provision` + `npm run test:e2e` against isolated staging and attach
the report; then work the manual assistive-technology narration pass.
