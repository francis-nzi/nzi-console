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
- **Entry:** Phase 1 banked. *(NZC-042 closed — factors are not site-scoped; no longer a gate for any slice.)*
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
- **NZC-042 — site-scoped factor overrides:** ✅ **closed** — factors are not site-scoped (they live on the row, not the site); a site on its own tariff is a per-site row. No decision pending; S3 unblocked.
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
enumerates the enabled flags (e.g. `spend`, later `spend,commuting`). Off/empty = the current generic
path. `render.yaml` carries the intended value for continuity, but **the Render dashboard value is
authoritative on this service** and `NEXT_PUBLIC_*` is build-inlined — so a flip is a dashboard edit +
rebuild, not a `render.yaml` merge. Full procedure in `docs/DEPLOYMENT.md` §"Feature-flag flips".

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
| B5.1 | Portal CSV upload (hardening slice) | NZC-036 | `portal-spend` | in `ACCEPTANCE_B5_PORTAL_SPEND.md` | B5, B4 parser | 🟡 gate drafted for Francis (1 open question) |
| S1 | Source register group roll-up + commuting/vehicle framing + bulk paste (register itself already built) | NZC-043/037/036 | `commuting`,`vehicle` | `ACCEPTANCE_S1_SOURCE_REGISTER.md` · `STAGING_ACCEPTANCE_S1.md` | migrations 0036/0037/0043 | 🟢 **fully built** (model + flagged register UI + S1.1 commuting + S1.2 vehicle bulk); per-domain flips pending staging flag + screen-reader — **largest, done** |
| S2 | Client factors UI — lifecycle (list · versioned edit · archive · reuse) + EPD lineage | NZC-041 | `client-factors` | `ACCEPTANCE_S2_CLIENT_FACTORS.md` · `STAGING_ACCEPTANCE_S2.md` | migration 0034 (on `main`) | 🟢 built (increments 1–2); flip pending staging flag + screen-reader (gate 9) |
| S3 | Sites-as-places + apportionment | NZC-042 | `sites` | new gate | migration 0035 | ⏳ **unblocked** (NZC-042 closed — factors not site-scoped); not yet started |
| S4 | Row/drawer breadth (data_confidence, conversion memory, notes, column text) | NZC-044 | (folds into S1–S3) | within host slice | 0034–0036 | ⏳ partial |
| UX1 | **One data-entry UX — scope→category accordion + shared capture component + site-as-context + progressive disclosure** (corrects the 31 Aug prototypes; absorbs S5's data-entry portion) | **NZC-046** | `data-entry-accordion` | `ACCEPTANCE_UX1_DATA_ENTRY_ACCORDION.md` · `STAGING_ACCEPTANCE_UX1.md` · `DATA_ENTRY_UX.md` | B2–B5, S1, S2 built | 🟢 accordion live on staging (PR #68); flip acceptance in progress |
| UX1e | **Stage-as-section CRP workspace** — `/jobs/[jobId]` page-level IA to the `crp_v3` prototype: active stage expanded, prior a summary line, later a to-do card; Data Entry = the accordion only; command hero → focus strip. The reusable **NZC-024** module shell. Increments e1 (shell + Setup + Data Entry) → e2 (Factor Mapping + Review & QA surfaces) → e3 (Report & Publish + retire the legacy scroll). | NZC-038 / NZC-024 | `job-stage-sections` | `ACCEPTANCE_UX1E_STAGE_SECTIONS.md` | UX1 accordion live | 🟢 e1 built (PR TBD); e2/e3 ⏳ |
| S5 | Stage-as-section for the **other** families' workspaces (CRP → UX1e; data-entry portion → UX1) | NZC-038 | layout | design acceptance | UX1e e1–e3 landed | ⏳ cross-cutting — replicates UX1e |
| — | Standards (carbon emissions; dd/mm/yyyy) | NZC-039/040 | n/a | ride-along per slice | — | ⏳ per slice |
| P4 | Retire legacy generic path + remove flags | — | remove | — | all adapters accepted | ⏳ Phase 4 |

**Human-only gates (not Claude Code):** A3 (screen-reader narration) and A4 (contrast eyeball) bank Phase 1.
NZC-042 is **closed** (factors not site-scoped), so S3 is already unblocked. Any rendered accessibility
review of a new adapter screen is human-only, like A3.

**Separate downstream track:** C — job-family modularization (NZC-024, confirmed 1 Sep 2026; NZC-025). Its
**Phase 0** — the additive schema batch (`0045`–`0050`, NZC-052–056), fixtures and invariants, no UI — is
**done and on `main`**. The **LCA reference module** sits *after* the report (R-track / M7) and data-entry
tracks; M4 (additional services) rides on it. See M7 below and `docs/MODEL_FIDELITY_JOB_FAMILIES.md`.

**Rough shape:** ~3 spend/bulk slices (B3–B5, lower risk) + ~3 model-surfacing slices (S1–S3, S1 the
heaviest) + 1 cross-cutting layout pass (S5) + legacy retirement — plus the two human gates and one decision.

*Burndown added 31 Aug 2026; updated 31 Aug 2026 after B4 (#32) merged + deployed — B5 gate drafted next.*

## M6 — Client portal breadth (added 1 Sep 2026)

The live client portal is an 11-area product; the redesign so far is the M1 baseline (Data Entry, Reports,
governance of client entry). The remaining areas come across as **M6 · Client portal breadth**, on the shared
evidence spine and `@nzi/charts` (derived, never captured), one design language (left-nav for **areas**,
stage-as-section for **workflow surfaces**), reviewed-snapshot-backed, and flag-gated per area. Full
catalogue in `docs/GAP_ANALYSIS_PORTAL_BREADTH.md` (Part 2). Decision: **NZC-047**.

**Entry:** the data-entry framework (S-slices) is down and the reviewed-snapshot + `@nzi/charts` spine is
proven. Read surfaces (below) may run **in parallel** with later data-entry slices since they only read.

| Order | Area(s) | Shape | Flag | Depends on | Status |
|---|---|---|---|---|---|
| M6.1 | Metrics, Insights | PORT (read on snapshot + SVG charts; Insights off PNGs) | `portal-metrics`, `portal-insights` | reviewed snapshot, @nzi/charts | ⏳ |
| M6.2 | Portfolio, Dashboard | PORT/FOLD (composite read views) | `portal-portfolio` | M6.1 | ⏳ |
| M6.3 | Strategy / Actions | MODEL (new Actions + action-lever domain) | `portal-actions` | new domain model + NZC-047 open decision | ⏳ **largest** |
| M6.4 | SRS Readiness | MODEL (new readiness domain) | `portal-srs` | new domain model | ⏳ |
| M6.5 | Risk, Governance, Files | FOLD (Governance extends M1; Files on upload + AV) | `portal-risk`,`portal-governance`,`portal-files` | NZC-046 upload/AV | ⏳ |

**Exit per area:** its own acceptance gate + flag flip; reviewed-snapshot-backed; accessible. **Separate
downstream track:** C (job-family modularization) still sits ahead of M4 additional services and is unrelated
to M6.

*M6 added 1 Sep 2026.*

## M7 · Report Studio (R-track) — Report → Report Printing redesign (added 1 Sep 2026)

Spec: `docs/REPORT_PRINTING_UX.md` (**NZC-048–051**). Reference prototype: `docs/prototypes/report_v3.html`.
Each slice ships behind its own flag with a rendered acceptance pass, same discipline as the data-entry
adapters. **Sequenced after the data-entry tracks** (UX1 + adapters).

| Slice | Scope | Flag | Status |
|---|---|---|---|
| R1 | Print-safe chart pack — report charts to deterministic SVG from the snapshot + single render-ready signal (kills the PDF breakage) | `report-svg-charts` | 🟢 built (#76) + **flag live on staging 3 Sep 2026**; automated gate green (`docs/STAGING_ACCEPTANCE_R1.md`); human pass (gate #11) outstanding. Flag var: **`NEXT_PUBLIC_FEATURE_REPORT_STUDIO`**. |
| R2 | Section model + provenance — ordered versioned sections, `contentSource`, Reset-to-default (backend/model; no new editing UI) | `report-sections` | 🟢 built (PR #78); migration `0051` applied to staging; `docs/ACCEPTANCE_R2_SECTION_MODEL.md`. No visible change — R4 adds the editor + rendering. |
| R3 | Data-bound figure tokens — token catalogue + resolver + locked-chip renderer; extend the data-integrity banner to charts + tokens | `report-tokens` | 🟢 built (PR #80); `docs/ACCEPTANCE_R3_FIGURE_TOKENS.md`. Renders the R2 sections (read-only) with resolved chips. Flip pending staging flag + `report-figure-tokens.spec.ts` harden + human pass. |
| R4 | In-place section editing + Regenerate — rich-text scoped to section bodies; generalise Report Preparation AI to every section | `report-edit` | 🟢 built (PR #81); `docs/ACCEPTANCE_R4_SECTION_EDITOR.md`. Editor in the Report & publish stage. AI Regenerate uses deterministic per-section variants — a live-model call is a follow-up (needs the Anthropic client + key). Flip pending staging flag + spec harden + human pass. |
| R5a | Audit appendices (Full Emissions Audit + by Site/Scope/Category) + repeating-header/row-atomic print CSS | `report-paged` | 🟢 built (PR #90); `docs/ACCEPTANCE_R5_PAGED_OUTPUT.md` |
| R5b | On-screen Continuous / Page-view · A4 toggle, running header/footer, page-break markers — **Paged.js**, confirmed by Francis 4 Sep 2026 | `report-paged` | 🟢 built (PR #91); `docs/ACCEPTANCE_R5_PAGED_OUTPUT.md`; human check (Page view vs. actual PDF) pending before flip |

> R1 alone permanently removes the PDF-breakage problem and is the recommended first slice. R4/R5 are the
> client-facing pieces; hold client exposure until their rendered acceptance passes.

**Separate downstream track:** C — job-family modularization (NZC-024, confirmed 1 Sep 2026). **Phase 0 is
done** — the additive schema batch (`0045`–`0050`, NZC-052–056: LCA/PCF, Training, Consultancy) is on `main`
and applied to isolated staging, no UI. The R-track (M7) and DA-track (M8) have both now landed in full;
M9 (fast row-adding) was inserted ahead of the LCA reference module at Francis's explicit instruction (4 Sep
2026) — build M9 first, LCA **planning** may proceed in parallel but LCA **build** waits for M9 to land.
The **LCA reference module** (first family module behind `job-module-lca`) started once M9 merged — **slice
1 (the Model Register) built 5 Sep 2026**, `docs/ACCEPTANCE_LCA_MODULE_SLICE1.md`; remaining slices (line
items + factor mapping, transport legs + geocoding, recalculate + result snapshots, charts, report
manifest) are proposed there, awaiting confirmation before deep build — transport-leg geocoding in
particular is a genuine new external-dependency decision, same "propose, don't guess" pattern as DA1/R5b.
M4 (additional services) rides on the completed module. See `docs/MODEL_FIDELITY_JOB_FAMILIES.md`.

*M7 added 1 Sep 2026.*

## M8 · Data Assurance (DA-track) — Review & QA → assurance surface + job-process simplification (added 4 Sep 2026)

Spec: `docs/_handoff_DATA_ASSURANCE_brief.md` (to be retired). Prototype: `docs/prototypes/review_qa_v1.html`
(Artifact `bc4f6e3c`). Decisions **NZC-057–061**. **The active track (Francis, 4 Sep 2026.)** Two connected
changes: (A) retire the CRP **Factor-mapping stage** (mapping goes inline at capture) — 5-stage shell → 4;
(B) build **Review & QA** into a Data-Assurance surface — the Outputs tables become the QA surface with a
five-year trend, a four-flag integrity gap engine and a governed sign-off that freezes the same
content-addressed reviewed snapshot the R-track consumes (**built on the existing reviewed-snapshot
mechanism — not forked**).

**Revises NZC-024 / UX1e-1 (#71/#72):** the stage shell is now **4** sections. `StageSection` /
`StageFocusStrip` and the `job-stage-sections` flag are kept; only Factor-mapping is removed and its content
re-homed (roll-ups → Data entry; unmatched-factor rows → a Needs-attention lens). `STAGING_ACCEPTANCE_UX1E.md`
updated to the 4-stage shape in DA2.

| Slice | Scope | Flag | Acceptance | Status |
|---|---|---|---|---|
| DA5 | Entry unit set — `mi` + `passenger.km` / `passenger.mi` on the per-row list (NZC-061) | — | `emissionEntryModel.test.ts` | 🟢 **shipped** (PR #82) |
| DA1 | Backend: multi-year aggregation read models + **baseline / prior-year resolution** + gap-engine computation (4 flags) + gap-resolution store. No UI. | — (additive) | unit tests on aggregation + each flag; migration applied + schema-probe | 🟢 built (PR #83 baseline model, PR #84 trend + gap engine) |
| DA2 | Lifecycle 5→4: `jobWorkflowStages.crp` change + stage migration `0053` (Factor-mapping jobs → Data entry / Review & QA, logged "stage retired (NZC-057)"); retire the Factor-mapping stage section; re-home the per-entity register → Data entry, unmatched-factor rows → the Needs-attention lens | **— (no flag)** — the contract array + one-way migration have no clean seam; landed atomically like DA5 | `stage-sections.spec.ts` (4 stages, no `stage-factor-mapping`), `commands.test.ts` (4-stage adjacency), `migrations.test.ts` (0053 remap rule + guard) | 🟢 built (PR #85) |
| DA3a | Data Assurance **read surface** — five-year trend (BL pill, % vs BL), By scope / By site / Audit / Intensity tabs, CSV export | `data-assurance` | `data-assurance.spec.ts` | 🟢 built (PR #86); **flag live on staging 4 Sep 2026** (Francis); Cowork automated pass green, spec hardened; `docs/STAGING_ACCEPTANCE_DA3.md`; human pass (gate #12) outstanding |
| DA3b | Gap drawer + resolve/fix — right overlay (table stays full width), gaps list, `assurance.gap.resolve` (optimistic + `expectedVersion`), fix-the-row round-trip, doubles as row-detail | `data-assurance` | in `data-assurance.spec.ts` | 🟢 built (PR #87) |
| DA3c | Row approvals in-stage + **governed sign-off** (blocked while any gap open or any row unapproved) → `report.snapshot.create` freeze | `data-assurance` | in `data-assurance.spec.ts` | 🟢 built (PR #88) — integration outline confirmed by Francis 4 Sep 2026 |
| DA4 | Lean capture + drawer refine — core-fields capture; factor / quality / confidence / notes / docs / reasoned override move to the row drawer (NZC-058) | `entry-lean-capture` | `lean-capture.spec.ts` | 🟢 built (PR #89) |

**Order:** DA5 (done) → DA1 (done) → DA2 (done) → DA3 (done: 3a/3b/3c) → DA4 (done). **All five DA-track
slices are built.** DA2 has **no flag** (one-way contract + migration, no clean seam — atomic like DA5).
`data-assurance` is **flipped and live on staging** (Francis, 4 Sep 2026) — automated gate green, spec
hardened (`docs/STAGING_ACCEPTANCE_DA3.md`); its human sensory pass is the one item outstanding.
`entry-lean-capture` still needs flipping on the Render dashboard `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` value
+ rebuild (`render.yaml` alone is cosmetic — see `DEPLOYMENT.md`) — `lean-capture.spec.ts` is already
prepped to un-skip the moment it does (one line to delete, same as every other flag-gated spec in this
suite) — see `docs/ACCEPTANCE_DA4_LEAN_CAPTURE.md`.

**R-track interaction:** R1–R4, R5a and R5b are all built and merged (flag-off) — **the entire R-track
(M7) is now built.** DA's sign-off and the R-track's "Mark Final" freeze the same snapshot. Remaining work
across both tracks is flips + human passes, not code — see each slice's own acceptance doc.

*M8 added 4 Sep 2026.*

## M9 · Fast row-adding — template search + Reuse Previous Year Rows (added 4 Sep 2026)

Spec: Francis, 4 Sep 2026 — "the two fast row-adding facilities the live site has… consultants use both
daily." Decisions **NZC-062 / NZC-063**. Landed ahead of the LCA track (Track C) at Francis's explicit
sequencing — LCA planning proceeds in parallel, but this ships first. Docs:
`docs/ACCEPTANCE_FAST_ADD.md`.

| Slice | Scope | Flag | Acceptance | Status |
|---|---|---|---|---|
| NZC-062 | Add rows from template — fuzzy search across the whole job factor library; a pick stamps factor + scope + category + site into a fresh `scope.row.create` row, quantity empty, pending; multi-add (search stays open) | `data-entry-fast-add` | `templateSearch.test.ts`, `fast-add.spec.ts` | 🟢 built (PR #93) |
| NZC-063 | Reuse Previous Year Rows — rollforward generalised from the spend-only register to every `job_scope_rows` type (`rolled_forward_from_row_id`, migration `0055`); pick specific prior rows, factor + hierarchy + site copied in, moved-factor/not-in-selection/already-rolled-forward flagged | `data-entry-fast-add` (shared) | `scopeRowRollforward.test.ts`, `fast-add.spec.ts` | 🟢 built (PR #93) |

Both sit in the CRP Data-entry stage's accordion, directly below the site selector and above the
scope→category cards, gated behind one flag (`data-entry-fast-add` — split into two only if the two ever
need independent rollout). Flag OFF leaves Data entry byte-identical to before. Migration `0055` applied to
isolated staging before this PR's deploy (read by both new read models, always-on once the flag ships).

*M9 added 4 Sep 2026.*
