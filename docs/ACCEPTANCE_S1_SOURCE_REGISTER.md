# S1 — Per-entity source register + commuting/vehicle adapters: acceptance & flag-flip gate

**Purpose.** The exit criteria S1 must satisfy before each per-domain flag
(`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` values `commuting`, `vehicle`) is turned on. Phase 2/3 of
`REDESIGN_ROLLOUT.md`; written before the build because S1 is the heaviest slice and its **roll-up
correctness** is where defects hide. Scope: the shared `job_emission_sources` + `job_emission_groups`
register and the **commuting** and **vehicle** capture adapters (NZC-043), each rolling up into the
canonical scope row. Bulk paste is **deferred** (S1.1/S1.2). `spend` is a separate adapter (B-track).

## Entry (before build)
- **Model on `main`:** migration `0036_emission_source_register.sql` and the `@nzi/contracts` types
  (`EmissionSource`, `EmissionSourceGroup`, `EmissionSourceDetail`) — applied on staging.
- Built **behind per-domain flags, OFF by default**; the current generic data-entry path stays default and
  untouched. The register/model is additive and **inert until read**.

## The gate — all must pass before flipping a domain's flag

**1. Register & group model**
- [ ] Individual entities live in `job_emission_sources`; a `job_emission_groups` row carries the group's
  dataset/factor and rolls its members up.
- [ ] Kind-specific fields live in the typed `detail_json` — **commuting**: vehicle reg, commute mode,
  distance unit, WFH days/hours, employee name; **vehicle**: reg, make, model, fuel.
- [ ] `source_type` add paths are **vehicle and commuting only** (NZC-037 — non-vehicle assets go via Data
  Entry). `asset` remains a valid schema enum for legacy/roll-up rows but has **no manual add UI**.

**2. Roll-up invariants (gate-critical)**
- [ ] A group produces **exactly one auto-generated scope row** (`is_auto_generated=true`, linked to the
  group via `linked_row_id` / `auto_pair_kind`).
- [ ] The roll-up total is **recomputed deterministically from ENABLED members only** — toggling a member
  `enabled` off changes the total; disabled members are excluded.
- [ ] **No double-count:** the auto-generated row **excludes its members** from the scope total (the exact
  failure live guarded in commit 3ed5810e).
- [ ] The auto-generated row is **not independently editable** — quantity/factor edits happen on members;
  the derived row has no manual write path.
- [ ] The roll-up row carries **provenance + lineage back to its members** (member count + identities), and
  monthly totals reconcile to the sum of member monthly vectors.
- [ ] **Member change → review semantics:** when a member is added/edited/removed, the roll-up row's review
  state is invalidated (returns to pending) rather than silently keeping a stale approval.

**3. Per-domain capture**
- [ ] Monthly supported, reporting-period-aligned, calendar-indexed storage (NZC-032); annual roll-up
  derived; progressive (collapsed by default).
- [ ] `apply_pct` apportionment honoured on the member where relevant; `data_confidence` (H/M/L) captured.
- [ ] Commuting: scale-to-headcount and WFH handled per the domain; vehicle: registration lookup reused
  where present (shared component, not re-implemented).

**4. Governance spine unchanged**
- [ ] Independent review bound to the exact version; five explicit states (empty ≠ zero ≠ loading ≠ failed ≠
  success); optimistic concurrency with `expectedVersion` + stale recovery; member-level and roll-up-level
  review both coherent.

**5. Register UX**
- [ ] Exception-first default view; edits in the evidence drawer; the register stays calm (granularity in the
  register, one row per group in the scope layer).

**6. Isolation**
- [ ] Staging only; no production creds/data; schema migration-owned (no request-time DDL).

**7. Flag behaviour (per-domain)**
- [ ] `commuting` and `vehicle` flip **independently**; each OFF by default; resolves identically server- and
  client-side; flipping off instantly restores the current path; the shared register is inert until a domain
  flag is on.

**8. Tests & build**
- [ ] Contract/unit tests: group roll-up recompute, enabled-member filtering, no-double-count, derived-row
  immutability, member-change review invalidation, monthly reconciliation.
- [ ] Integration journeys per domain incl. negatives (stale version, cross-job, disabled member, orphaned
  group).
- [ ] `npm run typecheck`, `test:portal`, `test:staff`, `build -w @nzi/console` — all green.

**9. Accessibility & responsive (per domain)**
- [ ] Keyboard operation of register + group + drawer; labelled inputs; status announcements; visible focus;
  reduced-motion; contrast-safe; responsive phone→wide.
- [ ] **Rendered** screen-reader + viewport review recorded (human-only, like A3).

**10. Standards**
- [ ] "carbon emissions" (NZC-039); dates dd/mm/yyyy (NZC-040).

## Not gating
- **NZC-042 (site-scoped factors):** S1 uses `site_id` as a plain **assignment reference** only, so this
  decision does **not** gate S1 — it belongs to S3 (sites-as-places).

## Exit (per domain)
A domain's boxes ticked **plus** a `docs/STAGING_ACCEPTANCE_S1.md` record (evidence + deferrals + rollback
check) → flip that domain's flag on. `commuting` and `vehicle` flip separately; the flip is its own reviewed
change, never bundled with the build.

*Prepared 31 Aug 2026. Companion to `REDESIGN_ROLLOUT.md` (S1) and `MODEL_FIDELITY_DATA_ENTRY.md` §4
(the per-entity register) / §6 NZC-043.*
