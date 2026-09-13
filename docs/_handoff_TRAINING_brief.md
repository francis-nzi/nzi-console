# Handoff brief — Training family: staff module + trainee portal + client-portal view + entitlements

The Training family is the largest module and spans **three audiences**: NZI staff who deliver
it, the **individual trainee** who owns their training for life, and the **client/employer** who
sees their people's training and the places they've paid for. This brief covers all three plus
the entitlement/places commercial thread. It builds on `MODEL_FIDELITY_JOB_FAMILIES.md` §3 (the
`training_*` model), §7 (Training staff module follows the LCA L1–L7 reference pattern) and
NZC-056 (CRP↔Training via entitlements). Design note: `docs/TRAINING_WORKFLOW_REVIEW.md`.

**Design references (prototypes in `docs/prototypes/`):**
- Staff module → `job_training_v1.html`
- Trainee portal → `portal_trainee_v1.html`
- Client-portal training view → `portal_training_v1.html`

**Decisions — all CONFIRMED by Francis 13 Sep 2026:** (1) trainee identity is **person-centric**,
keyed on personal email, portable across employers — build it as the spine. (2) Entitlement
places are reserved by **consultant/CRM only** (no client/trainee self-book in this pass). (3)
**Verifiable public certificates build now** (ID + QR verify page, no login). (4) On email change,
**require re-verification AND** the former employer loses visibility of the person's new personal
details while keeping its historical funded record. Nothing below is open.

Standard rules: branch + PR; **typecheck AND build green**; theme-aware three-state; print-safe
`NziIcon` line-icon set (not emoji); dd/mm/yyyy dates (NZC-040); unit notation not pluralised
(£m/kWh/CPD hours). Governed spine throughout: versioned rows + expectedVersion, provenance,
content-addressed reviewed snapshots, permission-checked commands + audit events,
deactivate-not-delete, honest empty/loading/degraded states (never failed-as-zero). No
request-time DDL — schema is migration-owned.

---

## 0. The load-bearing decision — trainee identity is person-centric

Training is **personal to the individual**, so a trainee is a **person, not an employer's
contact**. This is the spine everything else hangs off; build it first.

🔴 **`trainees`** record (new) — the person: full name, **personal email = the login identity
   (changeable)**, phone, consent status. **Not owned by a client**; persists across employers
   and over time. `TRAIN` model tag in `MODEL_FIDELITY_JOB_FAMILIES.md` §3.
🔴 A **`training_bookings`** row references a **`trainee_id`** (migrate any inline name/email to
   trainee records). History — bookings, attendance, certificates — aggregates **per person**.
🔴 Each booking also freezes the **employer + funding context at the time**
   (`employer_client_id`, `entitlement_id?`). That attribution is **historical and immutable**:
   changing a personal email never rewrites who paid or who employed them.
🔴 **Third identity realm `trainee_auth`** — separate login + its own MFA/consent, mirroring how
   the client portal is separate from staff. Session-derived identity; never a URL parameter.

---

## 1. Staff Training module  (`apps/console/app/jobs/training/`)  — ref `job_training_v1.html`

The workspace over a training **run**. The **run is the versioned, reviewed unit**; reviewing it
freezes the attendance register + issued certificates into a content-addressed snapshot that the
family report and **both** portals read (they recompute nothing).

🔴 1. **Run header + stage machine** — Planned → Scheduled → In delivery → Delivered →
   Certified → Reviewed. Product/run identity, delivery mode, booked/cap, entitlement-funded
   count, certificates-ready, CPD hours. Provenance drawer.
🔴 2. **Sessions** — date, mode (in person / online), venue or joining detail, trainer, per-
   session attendance state. Attendance is captured **per session**; a session can be marked
   Upcoming/Delivered.
🔴 3. **Booking register** — one row per booking: trainee (link to the person), employer,
   **funding** (entitlement-place vs billed £), attendance % across sessions, consent state,
   certificate state. Guests from another employer are allowed and labelled.
🔴 4. **Attendance capture** — mark present/absent per session; attendance % is derived.
🔴 5. **Certificate issuance** — **policy-driven** (default ≥80% attendance across sessions),
   **held** where consent is pending. "Issue eligible certificates" is a permission-checked
   command writing audit events; certificates are content-addressed evidence with a **unique
   ID** and a public verify page (§4 — DECISION 3 = build now).
🔴 6. **Entitlements panel** — the places this client holds (from CRP jobs): granted / consumed /
   reserved / remaining, with **expiry** (default = granting job end date, CRM-movable — §5).
   Consumed atomically by bookings; a booking may be assigned from an entitlement.

Governance: reviewing the run freezes register + certificates; deactivate never delete; every
mutation audits.

---

## 2. Trainee portal  (new realm `trainee_auth`)  — ref `portal_trainee_v1.html`

The individual logs in with their **personal email** and sees their training across **every
employer**, aggregated per person. **Read-only** on the training facts (from reviewed run
snapshots); **editable only** on their own personal details + consent.

🔴 1. **My training** — every course (completed / in-progress), across all employers, each
   showing the arranging employer + delivered-by, attendance, CPD hours, certificate state.
🔴 2. **Upcoming schedule** — sessions with time, mode, venue/joining detail; add-to-calendar.
🔴 3. **Documents** — course materials released for runs they're on.
🔴 4. **Certificates** — download (PDF) + a **public verification link/QR** (§4).
🔴 5. **My details** — full name, **login email (change triggers email re-verification)**, phone,
   **current employer (self-updatable — the on-leave path)**, marketing consent. Past training
   stays attributed to the then-employer; updating details never rewrites history, and a former
   employer loses visibility of the person's new personal details while keeping its funded record.
🔴 6. **On leave (DECISION 4 = yes to both)** — changing the login email requires
   re-verification before it becomes the sign-in; the former employer keeps its historical funded
   record but **loses visibility of the person's new personal details** from that point.
🟠 7. **My data** — export-my-training (GDPR data-subject right): details + bookings + attendance
   + certificates.

Auth: separate realm; standard NZI never-enter-credentials rules — the trainee sets their own
password/MFA. Consent captured and versioned.

---

## 3. Client-portal training view  (extends the Projects hub)  — ref `portal_training_v1.html`

The **employer's** holistic view, added as a **Training** tab in the client portal
(`portal_projects_v1.html` is the hub). Client sees **its own slice only** — its people, its
engagements — **never** a trainee's cross-employer history. Read-only, from the reviewed training
snapshot via the **shared resolver** (no recompute); session-derived client identity, grant-checked.

🔴 1. **Places summary (headline)** — granted / used+reserved / **yet to be taken** (highlighted)
   / **expiring soon**. Unused places are money on the table — this is the commercial nudge.
🔴 2. **Per-entitlement rows** — granted vs used/reserved/available (with a places strip),
   **expiry with a warning state** as it approaches; expired places shown as **lapsed**, not
   silently dropped; link back to the granting CRP job.
🔴 3. **Training their team has taken** — person, course, completed date, attendance, certificate
   download. Assured mark: "from the reviewed training record".
🟠 4. **Skills matrix** — which staff hold which current training, with a **refresher-due** state.
🟡 5. **Download** — training certificates / register pack (same print-safe assets as the report).

Build to render **whatever a family has released**, so it lights up as the staff module lands;
an empty state is truthful, never a placeholder figure.

---

## 4. Verifiable certificates  (recommend building now — low cost, high demo/commercial value)

🔴 Each certificate carries a **unique ID** + a **public verification URL/QR**
   (`verify.netzero.international/<certId>`) so a future employer can confirm it **without a
   login**. This is a real benefit of portable, person-owned training and a sales differentiator.
   Certificates are already content-hashed evidence; the verify page shows issued-to (name),
   course, issue date, issuer, and validity — **no personal contact detail**. Revocable
   (deactivate → verify page shows "no longer valid"). **DECISION 3 = build now.**

---

## 5. Entitlements / training places  (the commercial thread — NZC-056)

🔴 1. Places **originate from the quote / commercial terms** (quote → CRP job); a manual **CRM
   grant** is the secondary path. Each is a `training_entitlements` row with lifecycle
   **available → reserved → consumed**, atomic (no double-consume).
🔴 2. **Expiry defaults to the granting job's end date and is CRM-movable in the backend** —
   editable `expires_at`, audited, with a **`default_from_job_end`** flag so "moved" vs "default"
   is legible. Expired places lapse (shown, not dropped).
🔴 3. Visible on **both** sides: the CRP job shows "5 places · 2 used · 3 remaining · expires …";
   the training run shows which bookings are entitlement-funded; the client portal highlights
   **remaining + expiry**.
🔴 4. **DECISION 2 = consultant/CRM only** reserves a place in this pass — no client/trainee
   self-book from the portal yet (revisit in Stage 2, §6).

---

## 6. Additional workflow improvements (invited — staged)

🟠 **Automated lifecycle comms** (`training_automation_log`): booking confirmation, session
   reminders, "certificate ready", and **place-expiry warnings** to client + trainee. Nudging
   unused places before they lapse is direct commercial value.
🟡 **CPD hours** on products/certificates. · **Post-course feedback** → quality data + testimonial
   pipeline. · **Waitlist** (model already has `waitlisted`) when a run is at capacity. ·
   **Refresher/renewal reminders** (annual re-training). · **Self-service booking** of places
   (DECISION 2). All Stage 2 unless pulled forward.

---

## Sequencing for Claude Code
1. **Person-centric `trainees` + `trainee_auth` realm + booking→trainee migration** (§0) — spine.
2. **Staff module** (§1) following the LCA L1–L7 reference pattern; run as reviewed unit.
3. **Entitlements** (§5) wired CRP↔Training; expiry default + CRM-movable.
4. **Client-portal training tab** (§3) — reads the shared resolver.
5. **Trainee portal** (§2) — new realm.
6. **Verifiable certificates** (§4) if DECISION 3 = now.
7. Automation/CPD/feedback/waitlist/refresher (§6) as Stage 2.

## Acceptance (real data; build+typecheck green; on a PR)
- A run drives its stage machine; attendance captured per session; certificates issue on policy
  and hold on pending consent; reviewing the run freezes register + certificates into a snapshot.
- A trainee logs into their own realm and sees training across employers; editing their email
  re-verifies; past attribution is unchanged; data export works.
- The client portal shows the client's staff training + places (granted/used/remaining/expiry)
  with yet-to-be-taken highlighted and expiry warnings; two clients see different slices; nothing
  cross-employer or unreleased leaks; empty states are honest.
- Entitlement places consume atomically; expiry defaults to job end and is CRM-movable (audited).
