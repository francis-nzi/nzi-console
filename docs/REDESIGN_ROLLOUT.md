# NZI Console — Data-Entry Redesign Rollout Plan

**Purpose.** Sequence the data-entry redesign into the Console rebuild programme with the least risk:
land the schema early (it's cheap and time-sensitive), don't disrupt in-flight acceptance, and roll the
new UI out behind flags. Companion to `DEVELOPMENT_PLAN.md`, `MODEL_FIDELITY_DATA_ENTRY.md`,
`GAP_ANALYSIS_DATA_ENTRY.md`, and the decision register `DECISIONS.md` (NZC-032–045).

**Scope of "the redesign".** Three separable things that must NOT land at the same moment:

1. **Model / schema** — the canonical row extensions and new entities (NZC-041–045; migrations 0034–0036,
   `@nzi/contracts`). *Additive, backward-compatible.*
2. **Capture UI** — the typed capture adapters (NZC-035) and the stage-as-section design language (NZC-038),
   across the CRP workspace and the client portal.
3. **Cross-cutting standards** — "carbon emissions" vs PCF-only "carbon footprint" (NZC-039) and dd/mm/yyyy
   dates (NZC-040).

## Guiding principles

- **Additive schema first.** New optional columns and tables land ahead of the layers that harden on them
  (M4 replicates the data-entry framework across job families). Retrofitting schema after that is expensive;
  landing it early is near-zero risk because nothing reads the new fields until the UI does.
- **Protect acceptance evidence.** Never introduce new UI while a rendered acceptance pass is being earned —
  it invalidates the evidence and mixes two kinds of change in one review.
- **One framework, portal + CRP.** The portal is a constrained mirror of the CRP capture (NZC-016/035); build
  the shared adapter once and surface it in both.
- **Strangler rollout.** Each capture adapter ships behind a flag with the current path intact until that
  adapter passes acceptance; then the old path is retired. No big-bang switch.

## Phases

### Phase 0 — Finalise & merge the additive schema/model
- **Goal:** the proven model (NZC-041–045) is committed and green, changing no current behaviour.
- **Entry:** the finalisation pass (contracts + migrations 0034–0036 + mock-data fixtures + tests) exists in
  the working tree.
- **Work:** run `npm run typecheck`, `npm run test:portal`, `npm run test:staff`, the contracts and
  mock-data package tests, and `npm run build -w @nzi/console`; apply 0034–0036 to the **isolated staging DB
  only**; confirm additive/backward-compatible and no request-time DDL; commit on a branch and open a PR.
- **Exit:** all checks green; migrations applied clean on staging; existing rows unaffected (new columns take
  defaults); PR merged. **No UI reads the new fields yet.**

### Phase 1 — Bank the current acceptance baseline
- **Goal:** lock M1/M2/M3 green on the *current* screens.
- **Entry:** Phase 0 merged.
- **Work:** the combined **M1/M2/M3 rendered browser-acceptance pass** (DEVELOPMENT_PLAN "immediate next
  action") — keyboard/screen-reader/contrast/reduced-motion, responsive at all breakpoints, and the
  enrolment-through-approval + data-submission journeys.
- **Exit:** `STAGING_ACCEPTANCE_M1/M2/M3.md` updated with rendered evidence; open browser-only items closed;
  rollback path re-verified.

### Phase 2 — First vertical slice (one adapter, flagged)
- **Goal:** validate the new framework end-to-end on one real capture kind before broad rollout.
- **Entry:** Phase 1 banked; **NZC-042 (site-scoped factor overrides) decided** if the slice touches sites.
- **Work:** build ONE adapter (recommended: **portal spend** or **commuting**) on the new model —
  kind-specific fields + monthly + the review/provenance spine — behind `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`
  (per-adapter granularity). Old generic path stays default. Bundle the NZC-039/040 standards into this slice.
- **Exit:** the slice passes its own contract + rendered acceptance behind the flag; parity check vs the old
  path (same governance, provenance, review); sign-off to widen.

> **Status (30 Aug 2026):** the **spend ledger adapter** is the Phase 2 slice — CRP-side, behind
> `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend` (OFF by default; `apps/console/app/lib/featureFlags.ts`). It does
> **not touch sites** (purchased goods are org-level; sources created site-less), so NZC-042 is not
> implicated. Paste a ledger → confirm a controlled PG&S category (advisory keyword suggestion, NZC-018) and
> a factor per line → each line becomes a `job_emission_sources` spend source synced to a **Scope 3.1** row
> carrying the **Spend-based** quality tier, through the unchanged calculation/lineage/independent-review
> spine. Not in this slice: file upload (NZC-036, Phase 3), controlled PG&S FK on the synced row (needs a
> small migration, Phase 3), the portal mirror (Phase 3). Flag stays OFF until the slice passes its own
> rendered acceptance.

### Phase 3 — Roll out remaining adapters + stage-as-section
- **Goal:** the full typed-adapter set and NZC-038 layout across CRP and portal.
- **Entry:** Phase 2 signed off.
- **Work:** remaining adapters (manual, spend, commuting, vehicle, import) writing canonical rows and, where
  per-entity, the source register (0036); the exception-first register, drawer edits (override, monthly,
  notes, client factor, apportionment), and stage-as-section shell — each behind its flag, each with
  acceptance before its flag flips on.
- **Exit:** every adapter live and accepted in both CRP and portal; standards applied site-wide.

### Phase 4 — Retire the legacy data-entry path
- **Goal:** remove the old generic record path and dead flags.
- **Entry:** all adapters accepted in Phase 3 and stable in staging.
- **Work:** remove the superseded generic entry code and its flags; confirm no data or route depends on it.
- **Exit:** one path only; suite green; DECISIONS/DEVELOPMENT_PLAN updated.

### Phase 5 — Proceed to M4 on the new framework
- **Goal:** additional services (LCA/PCF/Training/Sales V2) build on the redesigned data-entry framework, not
  the old one — so the family workflows are built once.
- **Entry:** Phases 0–4 complete.

## Feature-flag strategy
- One namespaced flag per adapter (e.g. `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2.spend`), off by default, resolved
  server- and client-side from the same source so behaviour is identical across render boundaries.
- Old path is the default until an adapter's flag flips; flags are removed in Phase 4.
- Flags gate **UI only** — the schema (Phase 0) is always present, since it's additive and inert until read.

## Decision gates
- **NZC-042 — site-scoped factor overrides:** decide before any Phase 2/3 slice that touches sites.
- Confirm each rendered acceptance pass (Phase 1, and per-adapter in 2–3) before flipping a flag.

## The one variable that changes the pace
**Are real clients already entering data through the portal?**
- **Yes:** schema-first-additive matters even more; every UI step (2–4) is a strict strangler behind flags
  with the old path intact and per-adapter acceptance before each flip; migrate in-flight drafts explicitly.
- **No / not client-live yet:** more freedom to move faster through Phases 2–3; still keep the flags so
  acceptance stays clean, but flips can be batched.

## Rollback
- **Schema (Phase 0):** additive columns/tables are inert; roll back by leaving them unused (no data loss) —
  do not drop columns that already hold data.
- **UI (Phases 2–3):** flip the adapter's flag off to fall back to the current path instantly.

*Prepared 30 Aug 2026. Sequencing rationale in the session discussion; entry/exit criteria are the gates.*

## Burndown — remaining slices (as of 31 Aug 2026)

**How the redesign is introduced:** the model schema is additive and already merged (inert until read); each
UI construct is then introduced as its own slice — build → its acceptance gate → flag flip. Progress is
counted in slices, not calendar time.

**Flag convention (as implemented):** a single env var `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` whose value
enumerates the enabled adapters (e.g. `spend`, later `spend,commuting`). Off/empty = the current generic
path. The committed value lives in `render.yaml` (source of truth), not the dashboard.

**Done**
- Model schema — migrations 0034–0039 + `@nzi/contracts` types (NZC-041–045). 0034 & 0036 confirmed on
  `main` (commit `db30d84`); all applied to staging.
- B1 typed capture fields (#5).
- B2 spend adapter (CRM) — live, flag on (`=spend`, #17); `docs/ACCEPTANCE_B2_SPEND_ADAPTER.md`,
  `docs/STAGING_ACCEPTANCE_B2.md`.
- **B3 previous-year rollforward + YoY variance advisory** (NZC-030; #19) — merged + deployed (#24, #26);
  migration 0039; e2e 42/42; `docs/STAGING_ACCEPTANCE_B3.md`. Only #25 (screen-reader pass, human-only) open.

**Remaining**

| # | Slice | Introduces (NZC) | Flag value | Acceptance gate | Depends on | Status |
|---|-------|------------------|-----------|-----------------|-----------|--------|
| B4 | CSV bulk import (CSV-first; `.xlsx` deferred) | NZC-036 | `spend-import` | `ACCEPTANCE_B4_IMPORT.md` | B2 | 🟢 built (#29–#32 merged + deployed); flip pending gate 9 + screen-reader |
| B5 | Portal spend mirror (paste + manual; CSV upload → B5.1) | NZC-016/035/036 | `portal-spend` | `ACCEPTANCE_B5_PORTAL_SPEND.md` · `STAGING_ACCEPTANCE_B5.md` | B2, portal framework | 🟢 built (increments 1–2); flip pending gate 5a (staging flag + portal security + screen-reader) |
| B5.1 | Portal CSV upload (hardening slice) | NZC-036 | `portal-spend` | in `ACCEPTANCE_B5_PORTAL_SPEND.md` | B5, B4 parser | ⏳ |
| S1 | Per-entity register + commuting/vehicle adapters | NZC-043 | `commuting`,`vehicle` | new gate | migration 0036 | ⏳ **largest** |
| S2 | Client factors UI — lifecycle (list · versioned edit · archive · reuse) + EPD lineage | NZC-041 | `client-factors` | `ACCEPTANCE_S2_CLIENT_FACTORS.md` · `STAGING_ACCEPTANCE_S2.md` | migration 0034 (on `main`) | 🟡 directions confirmed; increment 1 (backend) built; surface + flip pending |
| S3 | Sites-as-places + apportionment | NZC-042 | `sites` | new gate | migration 0035 **+ NZC-042 decision** | ⏳ blocked on decision |
| S4 | Row/drawer breadth (data_confidence, conversion memory, notes, column text) | NZC-044 | (folds into S1–S3) | within host slice | 0034–0036 | ⏳ partial |
| S5 | Stage-as-section layout rollout (CRP + portal) | NZC-038 | layout | design acceptance | adapters landed | ⏳ cross-cutting |
| — | Standards (carbon emissions; dd/mm/yyyy) | NZC-039/040 | n/a | ride-along per slice | — | ⏳ per slice |
| P4 | Retire legacy generic path + remove flags | — | remove | — | all adapters accepted | ⏳ Phase 4 |

**Human-only gates (not Claude Code):** A3 (screen-reader narration) and A4 (contrast eyeball) bank Phase 1;
the **NZC-042 decision** unblocks S3. Any rendered accessibility review of a new adapter screen is human-only,
like A3.

**Separate downstream track:** C — job-family modularization (NZC-024/025) — sits *after* all of the above;
M4 (additional services) rides on it. Parked until the data-entry framework is fully introduced.

**Rough shape:** ~3 spend/bulk slices (B3–B5, lower risk) + ~3 model-surfacing slices (S1–S3, S1 the
heaviest) + 1 cross-cutting layout pass (S5) + legacy retirement — plus the two human gates and one decision.

*Burndown added 31 Aug 2026; updated 31 Aug 2026 after B4 (#32) merged + deployed — B5 gate drafted next.*
