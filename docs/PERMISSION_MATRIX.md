# Permission matrix (resolves NZC-022)

The canonical roles, the enumerated capability names, and who holds what. This is the
source of truth for permission strings: **capabilities are added here, never invented in
code.** It closes the ad-hoc `finance.manage` / `financials.edit` naming the review found.

## Principles

- **Least privilege; default role is Viewer.** A new staff user starts read-only.
- **Every mutation is a permission-checked command that emits an audit event.** No
  mutating path is exempt; the check is server-authoritative (never UI-only).
- **Tenant safety by construction.** Every check is scoped to the org/tenant
  (`assert_client_access` / `assert_job_access`); a capability never crosses tenants.
- **Separation of duties.** The person who prepares a snapshot cannot be its sole
  approver; publishing a report to a client requires an approved snapshot.
- **Governed actions are audited regardless of role.** Re-baseline / recalculation always
  require a reason and are recorded on the baseline record + audit log.
- **Deactivate, never delete.** No role has a hard-delete capability.
- **The portal is a separate realm.** Portal users never receive staff capabilities;
  staff entering a client's portal context is itself an audited capability.

## Roles

| Role | Who | Shape |
|---|---|---|
| **Admin** | Org owner / platform admin | Everything, incl. the Admin Centre |
| **Consultant** | Account owner / CRM owner (the main staff role) | Owns clients & jobs; prepares, but does not self-approve assurance |
| **Reviewer** | Assurance / QA | Approves snapshots and publishes; does not prepare |
| **Finance** | Commercial / billing | The commercial ledger; read-only on the client record |
| **Viewer** | Read-only staff | Sees, changes nothing |

*(Portal users are a separate realm and are not a column here.)*

Legend: ✓ full · **R** read-only · ⚑ conditional (see note) · — none

## Matrix

| Capability | Admin | Consultant | Reviewer | Finance | Viewer |
|---|:--:|:--:|:--:|:--:|:--:|
| `client.view` | ✓ | ✓ | R | R | R |
| `client.create` | ✓ | ✓ | — | — | — |
| `client.edit` | ✓ | ✓ | — | — | — |
| `client.deactivate` | ✓ | — | — | — | — |
| `contact.manage` | ✓ | ✓ | — | — | — |
| `site.manage` | ✓ | ✓ | — | — | — |
| `target.edit` | ✓ | ✓ | — | — | — |
| `baseline.rebaseline` ⚑ | ✓ | ✓ | — | — | — |
| `job.manage` (create/edit) | ✓ | ✓ | — | — | — |
| `scoperow.edit` | ✓ | ✓ | — | — | — |
| `snapshot.review` (approve) ⚑ | ✓ | — | ✓ | — | — |
| `report.edit` | ✓ | ✓ | — | — | — |
| `report.publish` ⚑ | ✓ | — | ✓ | — | — |
| `report.view` | ✓ | ✓ | R | R | R |
| `strategy.manage` | ✓ | ✓ | — | — | — |
| `srs.manage` | ✓ | ✓ | — | — | — |
| `training.manage` (bookings, attendance, stage, certificate issuance) | ✓ | ✓ | — | — | — |
| `training.entitlement.manage` (move a place's expiry) ⚑ | ✓ | ✓ | — | R | — |
| `finance.view` | ✓ | R | — | ✓ | — |
| `finance.manage` (quotes/invoices/credit notes) | ✓ | — | — | ✓ | — |
| `portal.admin` (invite, reset MFA/pw, job access, data-entry windows) ⚑ | ✓ | ✓ | — | — | — |
| `category.visibility` (what a client sees of the category list) | ✓ | ⚑ own | — | — | — |
| `subject.review` (identity questions, spans organisations) ⚑ | ✓ | — | — | — | — |
| `subject.export` (reads a person's data back in the clear) ⚑ | ✓ | — | — | — | — |
| `subject.erase` (destroys a person's key, irreversibly) ⚑ | ✓ | — | — | — | — |
| `clientfactor.manage` | ✓ | ✓ | — | — | — |
| `dataset.manage` / `factor.manage` (calc-feeding config) | ✓ | — | — | — | — |
| `admin.users` / `admin.lookups` / `admin.templates` / `admin.settings` | ✓ | — | — | — | — |
| `audit.view` | ✓ | ⚑ own | R | ⚑ own | — |
| `support.portal_impersonate` (enter a client's portal context) ⚑ | ✓ | ✓ | — | — | — |
| `knowledge.capture` (offer a question + answer to the library as a draft) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `knowledge.approve` (draft → internal: live for staff, grounds the help AI) | ✓ | ✓ | — | — | — |
| `knowledge.publish` (internal → public: client-facing, website-bound) | ✓ | — | — | — | — |

### Conditional notes (⚑)

- `baseline.rebaseline` — always requires a reason and writes a governed baseline-change
  event; a Consultant can perform it on their own clients, an Admin on any.
- `snapshot.review` / `report.publish` — **separation of duties:** cannot be exercised by
  the same user who prepared the snapshot; `report.publish` additionally requires an
  approved snapshot to exist.
- `training.manage` — the training module's operational capability, a peer of
  `strategy.manage` / `srs.manage`; **not** `job.manage`, so a general job manager does not
  automatically issue NZI-branded verifiable certificates. **Certificate issuance is
  policy-gated** (attendance decides, consent holds) and **run review is a separate act under
  `snapshot.review`** — so the same separation of duties applies as everywhere else: the
  Consultant who delivers and issues does not self-approve the reviewed run snapshot.
- `training.entitlement.manage` — moving a place's expiry off its job-end default **always
  requires a reason, is audited, and clears the `default_from_job_end` flag** (treated like
  `baseline.rebaseline`). Held by the delivering team (Admin/Consultant), **not** finance-only —
  it's an operational concession on an already-granted entitlement, not a commercial re-sale;
  Finance keeps read visibility via `finance.view`.
- `audit.view` — Consultant/Finance see the audit trail for their own clients only.
- **Knowledge library (NZC-081).** Three capabilities, not two. Capture is held by every role —
  anyone who answers a question can offer it to the library — because writing to the library is its
  own act and should not ride an unrelated gate. Approval and publication are separate because they
  are separate risks: `knowledge.approve` makes an entry live for staff and citable by the help AI;
  `knowledge.publish` makes it client-facing and website-bound, and is **Admin only**. A Consultant
  writes most of the knowledge and can approve it internally, but cannot put anything in front of a
  client — which is what gives the two tiers their meaning.
- `support.portal_impersonate` — every entry is audited and time-boxed; it grants a
  read/preview context, never portal-user credential access.

## Naming convention

Lowercase, dot-separated: `domain.action`, or `domain.subdomain.action` where a domain has
sub-areas (e.g. `training.entitlement.manage`). Each segment is `[a-z_]+`; **two or more
segments are allowed** — the DB CHECK constraint was widened from its original single-dot
pattern (migration `0073`) to permit this, so do not narrow it back to `^[a-z]+\.[a-z_]+$`.
The enumerated list above is exhaustive; adding a capability means adding a row here first,
then the enum in `@nzi/contracts`. Legacy/ad-hoc strings found in review map as:
`financials.edit` → `finance.manage`; any `*.manage` invented outside this list must be
reconciled to a row here or added as one.

## Implementation notes

- Define the capability enum in `@nzi/contracts` from this list; the isolated backend's
  command layer checks it; the UI reads the same capability set to gate/hide controls
  (UI gating is convenience only — the server check is authoritative).
- Role→capability mapping lives in migration-owned config (no request-time DDL), and is
  versioned like other calc-adjacent config.
- Mark **NZC-022 = Resolved** in `DECISIONS.md`, pointing to this file.
