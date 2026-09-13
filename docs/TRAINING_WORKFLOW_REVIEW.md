# Training workflow — design review & additions

The Training family is the largest module and now spans **three audiences**: NZI staff (deliver
it), the **individual trainee** (owns their training for life), and the **client/employer**
(sees their people's training + the places they've paid for). This note sets the model and
workflow additions before the prototypes. Builds on `MODEL_FIDELITY_JOB_FAMILIES.md` §3 (the
`training_*` model — products, runs, sessions, bookings, attendance, entitlements, certificates,
all on the governance spine) and NZC-056 (CRP↔Training via entitlements only).

## The load-bearing decision: trainee identity is person-centric

Training is **personal to the individual**, so the trainee is modelled as a **person, not an
employer's contact**:

- New **`trainees`** record — the person: full name, **personal email (the login identity,
  changeable)**, phone, consent status. It is **not owned by a client**; it persists across
  employers and across time.
- A **booking references a `trainee_id`** (today it stores name/email inline). History —
  bookings, attendance, certificates — aggregates **per person**, so a trainee's record is
  whole even if they change jobs.
- A booking also records the **employer/client and the funding context at the time**
  (`employer_client_id`, `entitlement_id?`). That attribution is **historical and frozen**:
  when someone leaves, past training stays attributed to the then-employer; changing their
  personal email never rewrites who paid or who employed them.
- **On leaving employment**, the trainee updates their **own** contact details in the trainee
  portal (with email re-verification); their certificates and history stay theirs. The former
  employer keeps the historical record of what it funded; it no longer sees the person's new
  personal details.

This is a **third identity realm** alongside staff and client-portal: `trainee_auth`
(separate login + its own MFA/consent), mirroring how the client portal is separate from staff.

## The three surfaces

1. **Staff Training module** (`apps/console/app/jobs/training/`) — the workspace over the
   run: product/run header + stage machine, sessions, the **booking register** (each booking:
   trainee, employer, entitlement-funded?, billing, attendance, consent), **attendance capture**
   per session, **certificate issuance** (policy-driven off summed attendance), and the
   **entitlements panel** (places granted by CRP jobs — used/remaining/expiry). Governance: the
   **run** is the versioned reviewed unit; the reviewed snapshot freezes the attendance register
   + certificates for the family report.
2. **Trainee portal** (new realm) — the individual logs in with their personal email and sees:
   **my training** (all courses, across every employer), **upcoming schedule** (sessions,
   venue/online joining details), **documents** (course materials), **certificates**
   (download + a verifiable link), **my details** (editable, with email re-verification), and
   **consent / data** (consent status + export my data — GDPR). Read-only on the training facts;
   editable only on their own personal details and consent.
3. **Client portal — training view** (extends the Projects hub) — the employer sees the training
   **undertaken by their staff**: who trained on what, attendance, certificates issued, and the
   **entitlement places** they hold — **granted, used, remaining, and expiry** — with the number
   **yet to be taken highlighted** and expiry warnings. It shows the client's slice only (their
   people, their engagements), never a trainee's cross-employer history.

## Entitlements / training places (the commercial thread)

- Places **originate from the quote / commercial terms** (quote → CRP job) with a manual CRM
  grant as a secondary path (NZC-056). Each is a `training_entitlements` row:
  available → reserved → consumed, atomic (no double-consume).
- **Expiry defaults to the granting job's end date, and is movable by the CRM in the backend**
  (an editable `expires_at`, audited). Add a `default_from_job_end` flag so "moved" vs "default"
  is legible.
- The **client portal highlights places yet to be taken** (remaining = granted − reserved −
  consumed) and the expiry, with a warning state as expiry approaches; expired places are shown
  as lapsed, not silently dropped.
- Visible on **both** sides: the CRP job shows "5 places · 2 used · 3 remaining · expires
  31 Mar 2026"; the training run shows which bookings are entitlement-funded.

## Additional ideas to strengthen the workflow (invited)

- **Verifiable certificates.** Each certificate carries a unique ID + a **public verification
  URL/QR** so a future employer can confirm it without a login — a real benefit of portable,
  person-owned training, and a differentiator. (Certificates are already content-hashed evidence.)
- **Automated lifecycle comms** (via `training_automation_log`): booking confirmation, session
  reminders, "certificate ready", and **place-expiry warnings** to both the client and the
  trainee. Nudging unused places before they lapse is direct commercial value.
- **CPD hours** on products/certificates, so certificates count toward professional CPD.
- **Post-course feedback** (a short evaluation) → quality data + a testimonial pipeline.
- **Self-service booking of entitlement places** (client books their staff, or a trainee
  self-books, into an available run using a place) — optional; a decision below.
- **Waitlist** handling (the model already has `waitlisted`) surfaced when a run is at capacity.
- **Refresher / renewal reminders** — annual re-training prompts (e.g. carbon literacy refresh).
- **Trainee data portability** — export-my-training (GDPR data-subject right) from the trainee
  portal.
- **Skills view** for the client — a simple matrix of which staff hold which current training.

## Decisions for Francis (before/while I prototype)

1. **Trainee identity = person-centric, keyed on personal email, portable across employers** —
   confirm (everything above rests on it).
2. **Booking of entitlement places** — consultant/CRM books (like SRS, controlled), or allow
   **client/trainee self-booking** into available runs from the portal? (Affects both portals.)
3. **Verifiable public certificates** (ID + QR verification page) — build now or Stage 2?
   (Recommend now — low cost, high demo/commercial value.)
4. **On leave** — require **email re-verification** when a trainee changes their login email
   (recommend yes), and confirm the employer loses visibility of the person's new personal
   details while keeping the historical training record.
