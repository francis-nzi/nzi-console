# Build brief — Data Assurance stage + job-process changes (DA-track / M8)

**Prepared 04 Sep 2026 (Cowork).** Ready to build. Apply on branches + PRs — **do not force onto a live
working tree**. Prototype (signed off by Francis): `docs/prototypes/review_qa_v1.html`
(Artifact: https://claude.ai/code/artifact/bc4f6e3c-6f99-4131-857e-9b02bd139abb).

This brief does two connected things: (A) **simplifies the CRP job process** — mapping moves into capture and
the Factor-mapping *stage* is retired; and (B) **builds the Review & QA stage into a Data-Assurance surface** —
the Outputs tables become the QA surface, with a five-year trend, a four-flag integrity gap engine, and a
governed sign-off. It **revises** the 5-stage shell from NZC-024 / UX1e-1 (#71/#72) to 4 stages — that work is
kept, not discarded; the shell simply loses one section.

---

## 1. Decisions for the register (append to `DECISIONS.md`; highest today = NZC-056)

```
| NZC-057 | Four-stage CRP lifecycle: Setup → Data entry → Review & QA → Report & publish. "Factor mapping" is retired as a stage — factor selection happens inline at capture (auto-match via activity smart-search / DVLA lookup, user accepts). Unmatched-factor rows become a "Needs attention" exception within Data entry, not a stage everyone passes through. | Confirmed (04 Sep 2026) |
| NZC-058 | Lean capture + drawer refine: the entry form captures core fields only (registration→matched type or activity, quantity + unit, site-context, save). Factor override, quality tier, data confidence, evidence notes, supporting docs and reasoned override move to the row's right-hand detail drawer for post-save editing. CRM adopts the portal's core-fields-only capture model. | Confirmed (04 Sep 2026) |
| NZC-059 | Review & QA is the Data-Assurance stage: the aggregate Outputs tables (five-year trend, by scope, by site, audit, intensity) are the QA surface, in the same stage as row-level independent approval, under one sign-off that freezes the content-addressed snapshot Report consumes. Baseline year is always shown with the BL pill; the trend shows baseline + current + prior three years; "% vs BL" is a dedicated column (current vs baseline). Assurance is a right-hand overlay drawer so the data view keeps full width. | Confirmed (04 Sep 2026) |
| NZC-060 | Data-integrity gap engine: before sign-off, the dataset must clear four flag types — (1) YoY movement beyond the NZC-018 50%/200% band read against the trend, (2) completeness (a category/site with prior-year data now absent), (3) zero/blank where a value is expected, (4) unmapped/uncalculated (row with no factor or no calc). Each gap is either fixed (edit the row) or resolved-with-reason; the reason is recorded on the row's provenance. Sign-off is blocked while any gap is open. | Confirmed (04 Sep 2026) |
| NZC-061 | Entry unit set: add miles (`mi`) and passenger-distance units (`passenger.km`, `passenger.mi`) to the per-row entry unit list, which currently omits them (bug — vehicles/commuting cannot be entered in miles). Bulk paths already support `mi`; align the per-row list. | Confirmed (04 Sep 2026) |
```

Also: add **M8 · Data Assurance (DA-track)** to `REDESIGN_ROLLOUT.md` (burndown below), and add a note under
**NZC-024** that the job-family module shell is now **four** stages for CRP (Factor mapping retired).

---

## 2. Job-process changes (A)

### 2.1 Retire the Factor-mapping stage (NZC-057)
- **`packages/contracts/src/commands.ts:42`** — change
  `crp: ["Setup","Data entry","Factor mapping","Review & QA","Report & publish"]`
  → `crp: ["Setup","Data entry","Review & QA","Report & publish"]`.
  `isAllowedJobStageTransition` (adjacent-only) and `WorkflowStageControl` derive from this array, so both
  update automatically. **Leave the `pcf` family's "Factor mapping" stage as-is** — this change is CRP-only.
- **Data migration (required):** existing CRP jobs may sit at `workflow_stage = "Factor mapping"`, which becomes
  invalid. Migrate each such job to an adjacent valid stage: **→ "Data entry"** if any enabled row lacks a
  factor, else **→ "Review & QA"**. Record the remap in the stage-transition/audit trail with reason
  "stage retired (NZC-057)". Ship this migration in the same PR as the contract change, before deploy.
- **`apps/console/app/jobs/CrpScopeWorkspace.tsx`** — `stageBody` currently renders five `StageSection`s
  (line ~368) and `crpStages` at line 207. Remove the **Factor mapping** `StageSection`; re-home its content:
  - per-entity roll-up groups (`EmissionSourceRegister.tsx`) → into the **Data entry** stage (under the
    relevant category sections — vehicles/commuting already re-home there via `categoryExtras`);
  - the unmatched-factor list → a **"Needs attention"** lens/filter within Data entry (the accordion already
    has a Needs-attention toggle — surface `!row.factorLabel` rows there).
- **`CrpStageSections.tsx`** — now four sections; `StageFocusStrip` jump targets drop "Factor mapping".
- **No flag** (Francis, 4 Sep 2026): `jobWorkflowStages.crp` + the one-way stage migration have no clean
  seam to gate — a flag would only gate cosmetic UI while the contract + migration change globally. Land
  atomically like DA5. `data-assurance` (DA3) and `entry-lean-capture` (DA4) remain real flags.
  *(Delivered — PR #85; `docs/ACCEPTANCE_DA2_LIFECYCLE_4STAGE.md`.)*

### 2.2 Lean capture + drawer refine (NZC-058)
- **`apps/console/app/jobs/emissionEntryModel.ts`** — `buildEmissionEntryFields` currently pushes factor,
  quality tier, data confidence, note and supporting-docs into the CRM capture form. Split into:
  - **capture (core):** registration→matched type OR activity smart-search; quantity + unit; site-context; save.
    The factor is auto-set from the matched activity/lookup and shown read-only (accept), not a required pick.
  - **drawer (refine):** factor override, quality tier, data confidence, evidence notes, supporting docs,
    reasoned override, apportionment — the fields already shown in the row detail drawer (see the live
    scope-row drawer). CRM thereby matches the portal's constrained model (portal already drops these).
- Flag: **`entry-lean-capture`**.

### 2.3 Unit set fix (NZC-061) — ship immediately, no flag
- **`apps/console/app/jobs/CrpDataEntryAccordion.tsx:232`** — the unit list
  `[…,"kWh","litres","tonnes","km","m²","units"]` omits miles. Add `"mi"` and, for commuting/travel distance
  categories, `"passenger.km"` / `"passenger.mi"`. `vehicleBulk.ts` and `VehicleBulkPanel.tsx:162` already
  carry `"mi"` — align. Add a unit-normalisation test.

---

## 3. Data Assurance stage (B) — surface spec

Reference prototype `docs/prototypes/review_qa_v1.html`. The stage has one spine and supporting views.

- **Persistent header:** emissions summary (Total + Scope 1/2/3), baseline year with **BL pill**, reporting
  period, and an integrity banner ("N gaps to resolve" ↔ "Data integrity check passed").
- **Hero — five-year trend:** columns = **Baseline (BL pill, always shown)**, current year, and the prior
  three reporting years; a dedicated **"% vs BL"** column (current ÷ baseline − 1); an **Integrity** column
  carrying the flag chips. Flagged rows get a coloured left edge. Subtotals per scope + grand total.
  Emissions/Volume toggle. CSV export. Baseline and current columns tinted.
- **Supporting tabs:** By scope (category amalgamation + site count), By site (with an "Unallocated" completeness
  flag — hook for Sites-as-places, S3), Audit table (row lineage: factor, activity, quality, confidence, review),
  Intensity (per-denominator metrics across the trend), Row approvals (independent review in-stage).
- **Assurance — right overlay drawer (NZC-059):** the same shared detail drawer the app uses for scope-row
  detail (see the live scope-row drawer). It **overlays**, it does not dock in the grid — so the trend table
  keeps **full page width**; a "🛡 Data assurance · N" tab reopens it when closed. Default content = the gaps
  list; selecting a row shows that row's evidence/lineage in the same drawer. Contains a Gaps / Row approvals
  toggle.
- **Governed sign-off:** one action freezes the content-addressed snapshot (numbers + section text versions +
  chart source data — the same snapshot Report/NZC-051 consumes) and records reviewer + timestamp on the spine.
  **Blocked while any gap is open** and while any enabled row is unapproved.

### Gap engine (NZC-060) — four flag types
1. **YoY movement** — current vs the trend outside the NZC-018 [0.5×, 2×] band (extend `yoyVariance.ts` from
   single-prior to baseline + multi-year trend).
2. **Completeness** — a category (or site) with data in a prior year and none in the current year; the
   "shown for completeness" empties.
3. **Zero / blank** — a value expected (factor set) but 0 or missing quantity.
4. **Unmapped / uncalculated** — row with no factor or no calculation.

Each flag is **fixed** (edit the row → re-evaluate) or **resolved-with-reason** (free-text reason stored on the
row's provenance/lineage). A resolved flag no longer blocks sign-off but remains visible (resolved state +
reason) in the audit trail.

**Open item for Francis (default chosen):** when a "% vs BL" reduction is caused by an *unresolved* integrity
flag (e.g. Energy ▼100% because the quantity is missing), render the % **neutral grey until the gap is
resolved**, so an unverified data hole can't read as a genuine reduction; once resolved/fixed it takes its
normal green/amber. *(Recommended default — Francis to confirm; the prototype currently colours it green.)*

---

## 4. Backend / data model

- **Multi-year aggregation read models** (`packages/isolated-backend/src/readModels.ts`): scope→category and
  scope→category→activity aggregates per reporting year, plus by-site and intensity, for baseline + trailing
  four years. Resolve the **baseline + prior-year chain**: how a CRP job finds its baseline year and the prior
  reporting years for the same client (by client + reporting-year sequence / an explicit baseline reference on
  the job). This is the one genuinely new design piece — the existing `yoyVariance.ts` only knows a single
  rolled-forward prior quantity; generalise it.
- **Gap resolutions** — a store for resolved-with-reason (who/when/reason) keyed to row + flag type, surfaced on
  provenance. New migration (additive).
- **Sign-off / snapshot** — reuse the existing reviewed-snapshot mechanism (`ReviewedCrpSnapshotReadModel`,
  content-addressed `dataHash`) so Review & QA sign-off produces the frozen snapshot Report consumes; extend it
  to include the resolved-gap record so the sign-off is reproducible.
- **Migrations discipline:** every new column/table an always-on read model reads must be applied **before that
  PR's deploy** (see the two prior incidents). Add a schema-probe to the acceptance run.

---

## 5. Build slices, flags, acceptance

| Slice | Scope | Flag | Acceptance |
|---|---|---|---|
| DA1 | Backend: multi-year aggregation read models + baseline/prior-year resolution + gap-engine computation (4 flags) + gap-resolution store. No UI. | — (additive) | unit tests on aggregation + each flag; migration applied + schema-probe |
| DA2 | Lifecycle 5→4: contract change + stage migration; retire Factor-mapping section; re-home roll-ups to Data entry + unmatched to Needs-attention | **— (no flag)** | `stage-sections.spec.ts` (4 stages), `commands.test.ts` (adjacency), `migrations.test.ts` (0053 remap) — **done, PR #85** |
| DA3 | Data Assurance surface: five-year trend (BL pill, % vs BL), supporting tabs, right overlay drawer, gap list with fix/resolve, row approvals in-stage, governed sign-off + snapshot | `data-assurance` | `data-assurance.spec.ts` — see §5.1 |
| DA4 | Lean capture + drawer refine: core-fields capture; detail fields to the row drawer | `entry-lean-capture` | `lean-capture.spec.ts` — capture shows core only; drawer holds factor/quality/confidence/notes/docs; happy-path accept-match→qty→save |
| DA5 | Unit set fix: miles + passenger-distance | — | unit test + entry e2e can select miles |

### 5.1 `data-assurance.spec.ts` — assertions
- Trend renders **baseline column with BL pill (always present)** + current + three prior years; **% vs BL** is a
  separate column computed vs baseline (not prior year).
- Gap engine flags all four types on a fixture (a zeroed category, a category gone vs prior year, a >2× swing,
  an unmapped row); banner + drawer counts agree.
- Resolve-with-reason clears a gap, records provenance; fixing the row re-evaluates and clears it.
- Sign-off **disabled** while any gap open or any row unapproved; **enabled** when all clear; sign-off freezes a
  content-addressed snapshot and records reviewer + timestamp.
- Drawer overlays (open) and the table is **full width** when closed; reopen tab works.
- No horizontal **page** overflow at 390/768/1280/1920 (the wide table scrolls inside its own panel).
- **Flag hard-precondition:** assert the surface is actually built in (fail loud, never silent-skip) — same
  discipline as `stage-sections.spec.ts`.

---

## 6. Migrations & gotchas (read before building)
- **NEXT_PUBLIC flags are build-time inlined + the Render dashboard value is authoritative.** Every new flag
  (`entry-lean-capture`, `data-assurance`) must be **appended to the dashboard
  `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` value AND trigger a rebuild** — `render.yaml` alone is cosmetic on this
  service (already in DEPLOYMENT.md; confirm the note is there).
- **Migration ledger:** the manual `apply-migration` step has no ledger — a skipped number is invisible until a
  query hits it. Diff `packages/isolated-backend/migrations/*` against the DB and apply any gap **before**
  staging acceptance; apply always-on-read migrations before the deploy that reads them.
- **Branch/PR, no force.** Land on branches + PRs; preserve the working tree.

---

## 7. Sequencing & what this revises
- **Revises NZC-024 / UX1e-1 (#71/#72):** the stage shell is now **4** sections, not 5. The `StageSection` /
  `StageFocusStrip` components and the `job-stage-sections` flag are kept; only the Factor-mapping section is
  removed and its content re-homed. Update `STAGING_ACCEPTANCE_UX1E.md` to the 4-stage shape.
- **Meets the R-track at the snapshot:** DA sign-off freezes the same content-addressed snapshot the report
  (NZC-051, R-track) consumes — build DA's freeze on the existing reviewed-snapshot mechanism, don't fork it.
- **Order within DA-track:** DA1 (backend) → DA2 (lifecycle) → DA3 (assurance surface) → DA4 (lean capture),
  with DA5 (units) shippable immediately. Francis has prioritised this track now; sequence against the R-track
  at your discretion / per Francis.

---

*Delete this hand-off file once the register rows, rollout burndown and acceptance docs are created.*
