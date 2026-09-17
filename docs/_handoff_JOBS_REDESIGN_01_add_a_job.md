# Handoff brief — Jobs redesign · Part 1: Add a job (+ global "engagement → job")

First part of a **section-by-section UX redesign** to reduce cognitive overload across the job and
data-entry surfaces. Governing principle for the whole programme: **default to quiet — one active
section expanded with a clear single purpose, everything else collapsed to a one-line summary.** The
existing **auto-collapse of completed/idle cards is the model to preserve and extend, not replace.**

This part covers the **Jobs list page** and the **Create-job form**. Split into the PRs noted per task.

---

## Task A — Global terminology: "engagement" → "job"  (its own PR)
Normalise **all user-facing** "engagement(s)" to "job(s)": the "Engagements" page title, "New engagement",
the "Active engagements" tile label, "CRP engagements", the "NEW GOVERNED ENGAGEMENT" heading, and any
body copy. User-facing labels/copy only — do **not** rename internal code/data identifiers unless trivial
and safe. Careful pass so unrelated words aren't mangled. Prove with a grep that no user-facing
"engagement" remains.

## Task B — Jobs list: remove the hero band, keep the metrics
- **Remove** the dark "NZI DELIVERY COMMAND / The evidenced portfolio has no immediate milestones /
  Official job numbering, family-specific workflows and accountable ownership…" band **and** the ✓ pills
  (Official numbering / Named ownership / Audited workflow). It's self-referential chrome, not
  information.
- **Keep** the four stat tiles (Active jobs, Carbon reporting, Average progress, Due within 30 days). The
  "no immediate milestones" state is already carried by "Due within 30 days: 0".
- Page opens straight into the tiles + the job table.

## Task C — Create-job form
Group into two blocks to cut the wall-of-fields feel:
**About the job:** Client · Job family (drives Initial stage + workflow) · **Client Manager** (see Task D) ·
Title · Initial stage (derived from family, read-only).
**Dates:** Job start · Job end · Reporting period start · Reporting period end · **Reporting year
(derived, read-only)**.
- **Client Manager replaces "Owner"** — a team-member dropdown, **defaulted from the client's Client
  Manager**, changeable per job. The client-level job owner is **not** shown on this form.
- **Dates:** "Start date" → **Job start**; "Due date" → **Job end**; add **Reporting period start/end**.
  **Reporting year** is derived and read-only = **the calendar year of the reporting-period END date**
  (end 31/12/2024 → 2024; end 31/03/2025 → 2025). It is not entered.
- **Remove** the copy "The official number is assigned only when creation commits, so abandoned drafts
  never create gaps." Behaviour unchanged; the explanation goes.

## Task D — Client: add a Client Manager field  (migration)
- Add **Client Manager** (a team member) to the **Client** record — editable on the client, defaults onto
  each new job's Client Manager (Task C), overridable there.
- Migration via the **runner + ledger** → **stops for review**.

## Task E — Date sense-check (this also fixes a live bug)
Decision: **plausible window + ordering.** Enforce **both** client-side (min/max on the inputs) **and
server-side** (the real guard — native date inputs accept any year, which is how `22/11/98655` got in):
- 4-digit years within **[2000, currentYear + 5]**.
- **Job start < Job end**; **Reporting start < Reporting end**.
- All four dates **required**.
- Reporting year derived (never entered) = calendar year of the reporting-end date.
- Apply the same validation to **every path that edits these dates**, not just Create — so the live
  reporting-error bug is closed on edit too, not only on create. Clear inline error messages.

## Preserve / do not touch
- Auto-collapse of completed/idle cards.
- The governed create behaviour (official number assigned on commit).

## Acceptance (real data; on PRs)
- Jobs page: no hero band; stat tiles + table present; button reads **New job**.
- **No user-facing "engagement" remains** (grep).
- Create job shows **Client Manager** (defaulted from client, changeable), the **four dates**, and a
  **derived read-only Reporting year**; the "official number…" copy is gone.
- A 5-digit year, a wild year, or start-after-end is **rejected client- and server-side** with a clear
  message — on create **and** on edit.
- Reporting year reads as the **calendar year of the reporting-end date**.
- Client record carries an editable **Client Manager** that defaults onto new jobs.

## Rules
Branch + PR (Task A its own PR; B/C/E may group, D carries the migration). Migration via runner + ledger
→ **stops for review**. Theme-aware; accessible; audited; permission-matrix unaffected. Record the NZC
decision(s). Auto-delete-branches is on; frozen-branch rule (no pushes to a PR handed over). NZC-069 held.
Separately tracked (NOT this brief): the right-hand scope-row **drawer defect** (shows with nothing
selected; persists on Setup) — for the data-entry section.
