# S1 — Per-entity source register + commuting / vehicle adapters: acceptance & flag gate

> **STATUS: draft for Francis.** The largest remaining slice. Written before the build so scope and "done"
> are defined up front. Companion to `REDESIGN_ROLLOUT.md` (burndown row **S1**), `DECISIONS.md`
> **NZC-043** (per-entity register + roll-up), **NZC-037** (Company Vehicles replaces the Asset Register),
> **NZC-036** (bulk-upload standard), and `MODEL_FIDELITY_DATA_ENTRY.md` §3.

**Purpose.** Turn the already-built per-entity register into a **flagged, governed, complete** capture
surface for **Employee Commuting** and **Company Vehicles**, adding the two things NZC-043/036/037 require
that are not built yet: **group roll-up into one auto-generated canonical row**, and **bulk entry**
(paste grid + template) for the two domains.

**Not in S1:** the spend pathway (B2–B5, done), Business Travel (its own later slice), the stage-as-section
layout (S5), the portal mirror of commuting/vehicle (a later portal slice).

## What already exists (do not rebuild)

- **Schema** — `0036_emission_source_register.sql`: `job_emission_groups` (carries `dataset_id` /
  `factor_id` / `factor_label` / `unit`), `job_emission_sources` (`source_type` ∈
  `asset` | `vehicle` | `commuting` | `spend`, `detail_json`, `group_id`, monthly vector, `enabled`,
  `review_status`, client-factor boundary trigger + RLS); `job_scope_rows` gains `source_id` /
  `linked_row_id` / `is_auto_generated` / `auto_pair_kind`; `0037` — one canonical row per `source_id`.
- **Commands** — `emission.source.group.create`, `emission.source.create` (all four kinds, with
  kind-specific `detail_json` validated against `sourceType`), `emission.source.sync` (source → one
  canonical row, `is_auto_generated=true`, evidence hash + provenance), `emission.source.activity.update`
  (versioned, monthly, re-sync), `emission.source.status.update` (archive/restore + row exclusion),
  `emission.source.rollforward` (B3).
- **UI** — `EmissionSourceRegister` (`CrpScopeWorkspace`, **currently unflagged**): add a source of any
  kind with kind-specific fields (commute mode / WFH / registration; make / model / fuel), groups, the
  monthly editor, per-source sync status, activity edit, archive/restore, YoY variance advisory.
- **Read model** — `listJobEmissionSourceRegister` (groups + sources, `factorVersionMoved`, YoY prior,
  scope-row link + review status).

## What S1 adds

1. **Group roll-up (NZC-043).** A new `emission.source.group.sync` — aggregate a group's enabled sources
   into **one** auto-generated canonical row (summed quantity / summed monthly vector, the group's factor,
   `auto_pair_kind` = the group kind), instead of one row per source. The register shows a group as a
   single line with a member count and a combined sync status; individual member rows are not created.
   Existing per-source sync stays for ungrouped sources.
2. **Bulk entry for Employee Commuting + Company Vehicles (NZC-036).** A paste-and-validate grid per
   domain (mirroring the B2 spend grid): paste rows from a spreadsheet → one editable row per line with
   the domain's columns (Commuting: employee · mode · distance + unit · WFH days/hours · months;
   Company Vehicles: registration · make/model · fuel · mileage or fuel volume + unit · months) →
   validate live (units, factor match, months, duplicates) → commit each as a `job_emission_sources`
   entry through the unchanged create + sync + review spine. A **downloadable template** per domain
   (`.csv`, the NZC-036 identity block deferred with the `.xlsx` round-trip, as in B4).
3. **Company Vehicles framing (NZC-037).** The `vehicle` kind is surfaced as the **Company Vehicles**
   domain (registration-aware, monthly). **Non-vehicle Scope-1 assets** are captured through general
   Data Entry / the scope-row grid, not a separate register section — the register's `asset` kind is
   de-emphasised (kept for migration input, not offered as a primary "add" path). Grouping / roll-up for
   reporting is the group roll-up above.
4. **Flag + exception-first register.** Behind `commuting` and `vehicle` flag values; the register
   defaults to exception-first (unsynced / unmatched / pending first), members collapsed under their
   group.
5. **Standards** — "carbon emissions"; dd/mm/yyyy.

## Open questions for Francis (decide before build)

- **Q-S1-1 — group roll-up: replace or augment per-source rows?** Today each source syncs to its own
  canonical row. NZC-043 says a *roll-up* lands as one auto-generated row. **Options: (a)** a group syncs
  to **one** aggregated row and members do not get their own rows (cleanest for reporting; the register is
  where per-employee/per-vehicle detail lives); **(b)** keep per-source rows and add a group as a
  reporting *view* only. **Recommendation: (a)** — one canonical row per group, members in the register.
- **Q-S1-2 — bulk entry in S1, or defer?** The paste grid for commuting/vehicle is the bulk of the work.
  **Options: (a)** S1 includes the paste grid for both domains; **(b)** S1 = flag + group roll-up +
  Company Vehicles framing only, and the paste grid is **S1.1 / S1.2** (one per domain), like B4/B5.1.
  **Recommendation: (b)** — land the model (group roll-up) and the framing first; the paste grids are
  well-scoped follow-ons that reuse B2's grid patterns.
- **Q-S1-3 — Asset Register retirement (NZC-037).** Confirm the `asset` kind is dropped from the
  register's "add" UI now (captured via Data Entry instead), keeping the column only as migration input —
  or keep `asset` in the register through S1 and retire it in Phase 4.
- **Q-S1-4 — flag granularity.** One `source-register` flag for the whole register, or per-domain
  `commuting` / `vehicle` (already in the `DataEntryAdapter` union)? **Recommendation: per-domain** —
  `commuting` and `vehicle` flip independently, each with its own acceptance.
- **Q-S1-5 — the register is live unflagged today.** Same as S2-Q4: gate the *new* constructs (group
  roll-up, bulk grid, Company Vehicles framing) behind the flags; the current one-at-a-time register
  stays live until the flips. Confirm.

---

## The gate — all must pass before S1's flags flip

### 1. Group roll-up (NZC-043)

- [ ] `emission.source.group.sync` aggregates a group's **enabled** sources into one canonical row:
  summed annual quantity, element-wise summed monthly vector (reporting-period-aligned), the group's
  factor, `is_auto_generated=true`, `auto_pair_kind` = group kind, `source_id` NULL (the row pairs to the
  group via a new `group_id` link on `job_scope_rows`, or `linked_row_id`).
- [ ] Members of a synced group **do not** get individual canonical rows; removing a member re-aggregates;
  the row goes `review_status='pending'` on any member change (unchanged review spine).
- [ ] Provenance/lineage on the group row names the group, the member count, and the summed inputs; the
  evidence hash covers the member set so a member change forces regeneration.
- [ ] Ungrouped sources keep per-source sync (unchanged).

### 2. Bulk entry (NZC-036) — *if Q-S1-2 = (a); otherwise S1.1/S1.2*

- [ ] Paste grid per domain: parse pasted rows (pure, reuses the B2 splitter), one editable row per line,
  live validation (required fields, unit, factor match, month identity, within-file duplicates —
  advisory, never blocking per NZC-018).
- [ ] Commit creates one `job_emission_sources` per line through the unchanged create + sync path; a
  batch shares an id for undo (audited soft archive, mirroring B4's void discipline).
- [ ] `.csv` template download per domain; the identity block + `.xlsx` round-trip are deferred (B4 line).

### 3. Company Vehicles framing (NZC-037)

- [ ] The `vehicle` kind is presented as **Company Vehicles** (registration-aware, monthly, fuel/mileage).
- [ ] Per Q-S1-3, the `asset` kind is removed from / de-emphasised in the register's add UI; non-vehicle
  Scope-1 sources go through Data Entry; the scope-row category path still groups them for reporting.

### 4. Governed spine unchanged

- [ ] Every source and every roll-up row travels create → sync → **independent review**; nothing
  auto-approves; optimistic concurrency (`expectedVersion`) and stale recovery as today; submitted data
  never counts as reviewed emissions until approved.
- [ ] Archive/restore a source (or a whole group) excludes/re-includes its canonical row and forces fresh
  review; audited.

### 5. Isolation & schema

- [ ] Additive migration(s) only — expected: a `job_scope_rows.group_id` (nullable, FK to
  `job_emission_groups`, ON DELETE SET NULL) + a partial unique index (one roll-up row per group),
  RLS-covered, migration-owned, applied to isolated staging before merge. No request-time DDL.
- [ ] `NEXT_PUBLIC_APP_ENV=staging`; synthetic data only.

### 6. Flag behaviour

- [ ] `commuting` / `vehicle` values in `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`, OFF by default, resolve
  identically server/client, gate **only** the new constructs. With them off, the current register works
  exactly as today. Removing the values restores today's behaviour.

### 7. Tests & build

- [ ] Contract: `emission.source.group.sync` validation; (bulk) grid parse + row validation.
- [ ] Backend: group roll-up sums quantity + monthly correctly; member add/remove re-aggregates and
  re-pends; archive of a group; ungrouped sources unaffected; (bulk) batch create + soft-undo.
- [ ] Read model: the register exposes group roll-up state (member count, combined sync/review status).
- [ ] `npm run typecheck`, `test:portal`, `test:staff`, contracts + mock-data, `build -w @nzi/console` —
  green. No new runtime dependency.

### 8. Accessibility & responsive

- [ ] The register + (bulk) grid: labelled controls, keyboard-operable, status announced, visible focus,
  contrast-safe, no horizontal overflow at 390 / 768 / 1280 / 1920. Automated axe + responsive in the
  e2e spec (skips until the flags are on a staging deploy).
- [ ] **Rendered screen-reader pass — human-only**, folded into the #22 / A3 / #25 session.

### 9. Standards

- [ ] "carbon emissions" (NZC-039); dates dd/mm/yyyy (NZC-040) including the monthly labels and templates.

## Exit

All boxes ticked **plus** `docs/STAGING_ACCEPTANCE_S1.md` (evidence + known limitations + rollback). Each
flag flip is its **own reviewed change** after a rendered acceptance pass.

## Proposed build order (assuming Q-S1-2 = (b))

1. **Docs** — this gate, reviewed and merged (this PR).
2. **S1 core** — `emission.source.group.sync` + the `job_scope_rows.group_id` migration + read-model
   roll-up state; the flagged exception-first register with group roll-up and the Company Vehicles
   framing; backend + e2e.
3. **S1.1** — Employee Commuting paste grid + `.csv` template (its own gate section, appended here).
4. **S1.2** — Company Vehicles paste grid + `.csv` template.
5. Separate PRs: flip `commuting`, then `vehicle`, in `render.yaml`.

*Prepared 31 Aug 2026. Depends only on migrations `0036`/`0037` (on `main`). Extends the B/S gate line.*
