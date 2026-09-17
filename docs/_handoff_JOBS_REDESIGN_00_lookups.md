# Handoff brief — Redesign · Part 0 (foundation): Reference data / Lookups

The rebuild has **no lookups defined**; the live system holds a mature, curated set. The client and job
forms' smart-searches (industries, referrals, team owner/manager, etc.) resolve against these, so this is
the **foundation Parts 1 & 2 depend on — build it first.**

**Decisions (Francis):** migrate the curated lists **from live**; build **all categories now** as one
foundation.

## How lookups are handled (the design — answer to "is this the best way?")
A single **governed reference-data subsystem** on the spine, not flat editable lists:
- Each category is reference data: **versioned, provenanced, audited, deactivate-not-delete** (the live
  "Archive" = deactivate, never hard-delete).
- **Scope per category:** shared/global for universal standards (Industries, Currencies, UoM, VAT Rates,
  Payment Terms, Job File Types, Positions); org-scoped for firm config (Job Types, Job Statuses,
  Portfolios, Client Teams, Referrals, Action Categories, Governance Subjects, BD Bin Reasons, Time
  Subjects, Processes, Job Item Categories). Claude Code confirms each; default: org-scoped for firm
  config, shared for standards.
- One admin **Lookups Management** surface (mirrors live): curate / add / edit / archive,
  capability-gated + audited.
- The client/job **smart-searches read from this subsystem** (Part 1 team → owner/manager; Part 2
  industries, referrals).

## Categories to port (from the live admin)
Job Types, Job Statuses, VAT Rates, Payment Terms, Positions, Processes, Job Item Categories, Job File
Types, UoM, Action Categories, Governance Subjects, BD Bin Reasons, Time Subjects, Portfolios,
Industries, Referrals, Client Teams, Currencies.
**Plus Team members** (from Team Management / People & Access — a separate subsystem from Lookups, but
required for the owner/manager smart-searches). Confirm whether the rebuild already has a team roster; if
not, port it too.

## Migration — live is PRODUCTION, export-only
- **Never write to live.** Extract via the **live admin's Import/Export** (application-level, reference
  data) — **not** a database dump (a dump risks secrets and breaks live-untouched). Francis runs the
  export in live and hands over the files.
- **Reference data only, no secrets/credentials.** Team members carry names/emails (the firm's own team)
  → into isolated staging only; the firm's data, not to be exposed further.
- Claude Code builds:
  1. **Schema** for the reference-data subsystem (all categories) — migration via runner + ledger →
     **stops for review**.
  2. **Import/seed** loading the exported lists — **idempotent, reconcile-by-reading**, tested per
     **§14/§15** (run twice, over a dirtied DB, real-Postgres CI). Same class of seed as the
     portal-acceptance one — the same rules apply.
  3. **Admin Lookups Management** surface — governed CRUD (add / edit / archive = deactivate),
     capability-gated, audited, theme-aware.

## Sequencing
Prerequisite for **Part 1** (team → Client Manager) and **Part 2** (industries, referrals). Land the
schema + import + at least **Industries, Referrals, Team** with read APIs before wiring those forms'
smart-searches. The full admin surface can follow, but the data + reads the smart-searches need come
first.

## Acceptance
- The rebuild holds all live categories' curated values, imported faithfully (**spot-check counts against
  live** per category).
- Each category is admin-manageable (add/edit/archive), versioned + audited; archive = deactivate-not-delete.
- Scope correct per category (shared vs org-scoped).
- Client/job smart-searches resolve against the subsystem (industries, referrals, team owner/manager).
- Import is **idempotent** (re-run = no duplicates), tested twice + over a dirtied DB in real-Postgres CI.
- **Live was never written to** (export-only).

## Rules
Branch + PR; schema + import migrations via runner + ledger → **stop for review**; a new lookup-admin
capability is a **new matrix version**; theme-aware; audited; deactivate-not-delete. Live untouched; no
secrets moved; no DB dump. Record the NZC decision. Auto-delete-branches on; frozen-branch rule. NZC-069
held.
