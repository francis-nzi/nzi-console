# Handoff brief — Staff portal preview ("Go to portal" / view-as-client)

Surfaced during the NZC-080 walk-through: staff have **no way to see a client's portal** from the
client section. The only existing path — enrol a portal user and log in as them — is confusing and is
currently **erroring** ("Register unavailable", "Sign-in could not be completed"), so it's parked for a
separate revamp (see the end). CRMs/consultants need to see what a client sees. This brief builds that,
the governance-safe way.

## What it is — and what it is NOT
A **read-only staff preview** of a client's portal, opened from the client section, rendered **as the
staff user** — **not impersonation**, not a portal session, no client-attributed actions. The consultant
sees exactly what the client sees, from their own identity, read-only, audited.

## Governance rails (non-negotiable)
- **Staff identity, not impersonation.** The audit records "<staff> previewed <client>'s portal" — never
  an action attributed to the client, never a portal login as the client.
- **Same read models as the client portal.** The preview renders the plan + readiness through the
  *exact* resolvers the client portal uses — same numbers, same `include_in_report` gating, withdrawn
  exclusions, draft-hidden, as-at + provenance. No divergent second path that could show something the
  client wouldn't (or vice versa). One source of truth.
- **Read-only.** No data-entry, upload, or portal actions reachable in preview.
- **Capability-gated.** A new `portal.preview` capability at a **new permission-matrix version**
  (generator, never an edit), held by client-facing staff (Consultant/CRM + Admin — confirm the set).
  ⚠️ The matrix already lists **`support_portal_impersonate`** — reconcile before adding: is this preview
  the read-only realization of that existing capability, or genuinely distinct? Understand what
  `support_portal_impersonate` does today; do **not** create two overlapping impersonation-ish concepts.
- **Tenant/client-scoped.** Staff can only preview clients they're already authorized for; the preview
  grants **no new data reach** (permission parity, staff-side).
- **Unmissable banner.** A persistent "Staff preview · <Client> · read-only" bar so it can never be
  mistaken for the live client view.
- **Respects the portal feature-flag gates** (`portal-plan`, `portal-readiness`) so the preview reflects
  the client's actual experience — and so NZC-080's gate criteria are testable through it.
- **Fully audited** (actor = staff, client, correlation id), like every other command.

## Entry point
A **"Go to portal"** / **"Preview portal"** action on the **client Overview**, beside the existing
"Portal access" admin panel and "Create job". Opens the preview for that client.

## Acceptance (real data; on PRs)
- Staff with `portal.preview` see the action; without it, it's absent.
- Opening it renders the client's plan + readiness **identical to the client's own view** (same read
  models — verify against the same client's real data).
- Read-only: no entry/action controls present anywhere in the preview.
- Tenant parity: a staff member cannot preview a client they lack access to (assert with a test).
- Banner present and persistent.
- Pulling a portal feature-flag hides the corresponding surface in preview; restoring it returns it.
- Every open is audited with the staff actor (never client-attributed).

## Relationship to NZC-080
This unblocks acceptance of the **content**, **gate**, and **single-tenant** criteria (walk them through
the preview). The criteria that depend on the actual **portal login/auth** path — cross-tenant-via-portal-
auth, the login/MFA flow — are **deferred to the portal-login revamp** and recorded as deferred on those
rows, **not silently ticked**.

## Also record (parked NZC — do not build here)
The **portal enrolment + login flow** (invite → single-use setup link → password/TOTP → `/portal/login`)
is unreliable: "Register unavailable" and "Sign-in could not be completed" across the panels; the setup
link's single-use/on-screen-only handling is a trap; likely root cause to check first is
**`NZI_WRITE_API_ENABLED` not `true`** on staging (would 503 these writes). Needs a full revamp after
staging — track it as its own NZC, distinct from this preview.

## Rules
Branch + PR; matrix change is a **new version**; theme-aware; read-only; every open audited; retrieved
content is data. Record the NZC decision(s). Stops for review. NZC-069 held.
