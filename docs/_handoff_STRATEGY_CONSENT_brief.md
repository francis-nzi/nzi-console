# Handoff brief — Email consent capture (production gate for strategy reminders §6)

The one thing standing between the shipped reminder worker and a real client email. It adds a
**governed, audited way to record `client_contacts.email_consent`**, so the fail-closed default
(`unknown` = blocked) can be deliberately moved to `granted` — through a control with a basis and
an audit trail, never by a hand-edit in the database.

**Context (what already exists, do not rebuild):**
- #165 / migration `0083` shipped `client_contacts.email_consent` (`unknown` / `granted` /
  `declined`; `unknown` blocks sending) and the reminder worker `nzi-console-reminders`.
- The worker is live on staging, self-suppressing on the isolated non-production boundary
  (verified 14 Sep 2026: outbox backlog drained as `skipped` ×42, `sent` 0, `strategy_automation_log` 0).
- The worker's tests already cover "only consented contacts get mail" and "consent re-checked
  just before sending" — so this slice must not break that contract; it feeds it.

**Two gates remain before any real reminder goes out on production — this brief is gate (a):**
- **(a) Consent capture** — an audited control to set `email_consent`. *This brief.*
- **(b) Live worker standup** — a second `nzi-console-reminders` worker against the **live** DB
  boundary with the real Office 365 `SMTP_*` values. A separate reviewed deployment (proposed to
  Francis, applied by Francis), **not** part of this slice. Noted here only so it isn't forgotten.

**Open questions for Francis (decide before/with build):**
1. Who records consent — consultant on the client's behalf, the client themselves in the portal,
   or both? (Recommended: staff-console first to unblock production, portal self-serve as phase 2.)
2. Lawful basis for client reminder emails is a **DPO/legal** question, not one for this build to
   settle — the platform models explicit consent conservatively regardless. Flag, don't decide.
   *(Not legal advice.)*

---

## 1. What this adds
- A control to move `email_consent` `unknown → granted` / `→ declined`, carrying: **actor**,
  **timestamp**, **basis** (`consultant-recorded` / `portal-self-serve` / `imported`), optional note.
- Consent state is **versioned + audited** like the rest of the governed spine; consent history is
  **deactivate-not-delete** — a withdrawal supersedes, it never erases the prior record.
- Every change writes an **audit event**. No silent state changes.

## 2. Surfaces (phased)
- **Phase 1 — staff console (unblocks production).** On the client's contact record, a consultant
  with the right capability records consent state + basis. Enough to switch on real reminders for a
  client who has confirmed by email/call.
- **Phase 2 — client portal (follow-on).** The contact sets/updates **their own** consent
  (self-serve — the most defensible basis). Reuses the existing portal auth + contact plumbing.

## 3. Semantics
- `granted` → sendable; `declined` → never send; `unknown` → blocked (**default, fail-closed**).
- The worker reads consent **at send time, not at enqueue** — so a withdrawal between enqueue and
  send suppresses the send. Confirm this matches 0083's model (the "re-checked just before sending"
  test suggests it already does).
- A withdrawal (`granted → declined`) takes effect on the **next tick** — no further sends.

## 4. Permission
- Recording consent on a client's behalf is gated by a capability — reuse the existing
  contact-management capability if one exists, else add `contact.consent.manage` — at a **new
  permission-matrix version** (never an edit). Held by **Admin + Consultant**; **Finance read-only**.
- Portal self-serve (phase 2) is the contact's **own** action, not a staff capability.

## 5. Honesty
- Display the real state **with its basis + date**; never render "granted" without a recorded basis.
- Empty/unknown shows as blocked, honestly — not as a silent no-op.

## 6. Report / portal
- No report change. Portal (phase 2) shows the contact their own consent state and lets them change it.

## Sequencing
1. Phase 1 staff-console control + audit + (if needed) a consent-audit table/columns via the runner.
2. Phase 2 portal self-serve.
(Gate (b), the live worker standup, is tracked separately and is Francis's deploy to apply.)

## Acceptance (real data; build + typecheck green; on a PR)
- A consultant moves a contact `unknown → granted` with a recorded basis; the change is audited and
  permission-checked at a new matrix version.
- On production, the worker then sends to that contact and logs it in `strategy_automation_log`;
  `granted → declined` stops further sends on the next tick; `unknown` stays blocked.
- Consent history is preserved (deactivate-not-delete); the UI never shows a bare "granted".

## Standard rules
Branch + PR; typecheck AND build green; any migration via the **runner + ledger** (stops for
review); matrix change is a **new version**; theme-aware; dd/mm/yyyy; honest states;
deactivate-not-delete; every mutation permission-checked + audited. NZC-069 stays held.
