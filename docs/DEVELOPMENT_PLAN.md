# NZI Console development plan

**Delivery model:** milestone-based, evidence-led, and continuously deployed to the isolated staging service. Each milestone has a definition of done. Work is grouped into coherent batches; a green build alone does not complete a milestone.

## Current programme

| Milestone | Status | Definition of done |
|---|---|---|
| M1. Client portal | In progress | A client can enrol, authenticate, see only granted work, review immutable publications, collaborate, manage security, provide authorised data, obtain deliverables, and complete all critical journeys accessibly on desktop and mobile. |
| M2. Core CRP workflow | Planned | Staff can configure a CRP job, collect activity data, resolve factors, inspect lineage, complete QA, freeze a snapshot, validate and publish it with a complete audit trail. |
| M3. Staff workspaces | Planned | Clients, Jobs, Datasets, Reports, and Platform workspaces support their canonical operational workflows with explicit states and permissions. |
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
- [ ] Route submitted data into the staff review queue; never treat client entry as reviewed emissions.
- [ ] Cover manual activity, spend, commuting, and vehicle entry according to the canonical scope-row model.

#### P4. Deliverables and document records

- [ ] Expose version-bound report PDF, certificate, and methodology deliverables.
- [ ] Verify file identity, content type, version, access grant, and download failure states.
- [ ] Keep screen, print, and downloadable evidence aligned to the same publication.

#### P5. Portal acceptance gate

- [ ] Keyboard, focus, screen-reader, contrast, and reduced-motion review.
- [ ] Responsive verification at phone, tablet, laptop, and wide desktop widths.
- [ ] Browser journey tests for enrolment through report approval and data submission.
- [ ] Permission, cross-client isolation, CSRF/origin, rate-limit, and stale-session tests.
- [ ] Staging acceptance record with known limitations and rollback check.

## Delivery rules

1. Work the active milestone from top to bottom unless a discovered security or data-integrity defect requires immediate containment.
2. Each batch must include implementation, proportionate automated tests, production build, workspace type checks, diff checks, deployment, and staging verification.
3. Progress reports name the milestone, completed batch, overall status, and next batch.
4. New scope is placed into the plan before implementation; “continue” advances the next unchecked batch.
5. Production remains out of scope until M5 is complete and explicitly authorised.

## Immediate next action

Continue **P3: constrained client data entry** by rendering the submitted-record queue for staff and defining explicit accept/reject promotion into the canonical review workflow.
