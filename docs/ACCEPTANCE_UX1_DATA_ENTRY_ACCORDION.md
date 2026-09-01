# UX1 — one data-entry UX (scope→category accordion): acceptance & rollout gate

> **STATUS: draft for Francis.** Implements **NZC-046** / `docs/DATA_ENTRY_UX.md` — the correction to the
> 31 Aug prototypes. Companion to `REDESIGN_ROLLOUT.md` (this supersedes/absorbs burndown row **S5**),
> `MODEL_FIDELITY_DATA_ENTRY.md`, and the B/S slices already built. Written before the build because this
> is an **IA rework of the largest surface** and the sequencing against the pending flag flips matters.

**Purpose.** Turn today's flat scope-row register + per-adapter panels into **one capture component** used
identically by the CRP workspace and the client portal, laid out as **collapsed scope→category accordions
driven by the dataset taxonomy**, with **site-as-context** and **progressive disclosure** of
category-specific fields (NZC-046 §1–§4).

**This is a container / IA rework, not new capture logic.** Every adapter already built (spend paste, spend
import CSV, commuting bulk, vehicle bulk, client factors, the source register, the portal spend mirror) is
**re-homed into its category section** — its command paths, review spine and provenance are unchanged.

## What already exists (reuse)

- The canonical model: `job_scope_rows` (+ `job_emission_sources` / groups / roll-up), all the
  `emission.*` / `scope.*` / `client.factor.*` commands, `emission.source.group.sync` (NZC-043), the
  independent-review spine, monthly vectors (NZC-032), the controlled category path `level_1..4` (NZC-045).
- The flagged adapters: `spend`, `spend-import`, `portal-spend`, `client-factors`, `commuting`, `vehicle`
  (`apps/console/app/lib/featureFlags.ts`).
- `crpScopeOptions` (the 15 Scope 3 categories + Scope 1/2), `crpScopeCategoryPath`.
- `job_dataset_selections` + `emission_factors.scopes` — the source of "which scopes/categories apply".

## What UX1 adds

1. **`listJobApplicableCategories(db, jobId)`** — from the job's selected datasets' factor scopes (+ any
   category already used on a row), the ordered list of **applicable** categories with per-category
   counts (entries · tCO₂e · completeness). Category names **verbatim** from the taxonomy (NZC-046 §1).
2. **`<EmissionEntryForm>`** — one shared capture component, **fixed field order** (NZC-046 §3): Source /
   description (+ ID/Ref) → Quantity + Unit → **Monthly** (under Quantity, collapsed, "Add monthly
   breakdown" → 12 reporting-period inputs + copy-month-1) → **category-specific detail** (§4) → Factor
   (CRP: pick; portal: authorised-only or hidden) → Evidence note. Used by CRP and portal.
3. **The accordion container** — collapsed category sections grouped by scope; one-line summary per
   section; **Add entry** per category opening `<EmissionEntryForm>` for that category; a small table of
   that category's existing entries inside the section.
4. **CRP second lens** — a top toggle: **By category** (accordion, default for input) ↔ **Needs
   attention** (today's flat exception list, for triage) over the same rows.
5. **Site-as-context** (NZC-046 §2) — a site selector at the top of data entry; the accordion is scoped
   to it; every new entry auto-allocates `site_id` from context (a single entry can still be overridden
   to *Unallocated*). "All sites" / "Unallocated" are options. CRP + portal identical.
6. **Progressive disclosure** (NZC-046 §4) — spend fields (Net / VAT / GL / PG&S sub-category) render
   **only** inside *Purchased Goods and Services*; the registration lookup + manual render **only** inside
   *Company Vehicles / Business Travel / Employee Commuting*; every other category is plain quantity +
   unit + monthly.
7. **Portal mirror** — the same accordion + component, constrained to the grant's authorised
   categories / sites / factors / units, submit-to-review, "submitted ≠ reviewed emissions".

## Open questions for Francis (decide before build)

- **Q-UX1-1 — sequencing vs the pending flips.** B4 (`spend-import`), B5 (`portal-spend`), S1
  (`commuting` / `vehicle`), S2 (`client-factors`) are **built and merged but flag-OFF**, awaiting the
  staging dashboard flag + a screen-reader pass. UX1 re-homes all of them. **Options: (a)** flip those on
  the **current** layout first (bank the acceptance), then UX1 re-homes them behind its own flag; **(b)**
  hold every flip and ship them **together** on the accordion, one big acceptance. **Recommendation: (a)**
  — the adapters' *logic* is already accepted; UX1 is a presentation change on top, and (b) turns four
  independent flips into one large coupled one.
- **Q-UX1-2 — flag.** A new `data-entry-accordion` value in `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`, gating
  the accordion container + `<EmissionEntryForm>` + site-context; the per-adapter flags stay independent
  and simply control whether *that category's* rich entry (bulk paste, CSV, roll-up) is available inside
  its section. Confirm, or collapse the adapter flags into one.
- **Q-UX1-3 — "applicable categories".** Is applicability purely *"the job's selected datasets have
  factors for that scope"*, or is there an explicit per-job category enable list Francis wants
  (a `job_categories` config)? **Recommendation: derived** from dataset selections + used categories,
  with Scope 3 always showing all 15 when any Scope 3 dataset is selected (so nothing is hidden that a
  consultant might need), collapsed.
- **Q-UX1-4 — Business Travel.** NZC-046 §4 makes Business Travel its own visible section with
  vehicle-reg **and** manual **and** air/rail/hotel types. There is **no Business Travel adapter today**
  (only commuting/vehicle). Is a Business Travel capture kind in UX1's scope, or a fast-follow
  (`business-travel` flag) once the accordion lands? **Recommendation: fast-follow** — UX1 ships the
  accordion + the re-homed existing kinds; Business Travel is UX1.1.
- **Q-UX1-5 — registration lookup.** "Two-step: look up → confirm vehicle → enter distance" implies a
  vehicle-data lookup service. Is there one to call (DVLA-style), or is "lookup" just structured manual
  entry (reg → make/model/fuel fields) for now? **Recommendation: structured manual** for UX1; a real
  lookup is its own slice with its own external-service review.

---

## The gate — all must pass before the `data-entry-accordion` flag flips

### 1. Structure (NZC-046 §1)

- [ ] Data entry renders as **collapsed** category sections grouped by scope; only **applicable**
  categories shown; names **verbatim** from the taxonomy; each section shows entries · tCO₂e ·
  completeness; **Add entry** per category; many rows per category in an in-section table.
- [ ] CRP **By category ↔ Needs attention** toggle over the same rows; "Needs attention" is exactly
  today's exception list; deep links / scroll-to-section still work.
- [ ] No canonical-model change — sections are a view over `job_scope_rows` + the register; the reviewed
  snapshot, charts and report are byte-for-byte unaffected.

### 2. One component, one field order (NZC-046 §3)

- [ ] `<EmissionEntryForm>` is the **only** entry form on both surfaces, with the fixed order; monthly is
  under Quantity, collapsed, reporting-period-aligned (NZC-032), copy-month-1→all preserved.
- [ ] The portal renders the **same** component; differences are constraint only (authorised sets,
  factor hidden/locked, submit-to-review) — not a different form or order.
- [ ] Every existing command path is unchanged (`scope.row.*`, `emission.source.*`, portal record
  create/submit, group roll-up); optimistic concurrency + five explicit states preserved.

### 3. Site-as-context (NZC-046 §2)

- [ ] A site selector at the top of data entry (CRP + portal); selecting a site scopes the accordion and
  **auto-allocates `site_id`** on every new entry; *All sites* / *Unallocated* options; a single entry
  can be overridden to *Unallocated*.
- [ ] Portal: the selector lists only the grant's authorised sites; the entry still writes through the
  unchanged portal record path.
- [ ] No per-row site field in the default form (it moves to context); the drawer keeps a site override
  for corrections.

### 4. Progressive disclosure (NZC-046 §4)

- [ ] Spend fields (Net / VAT % / GL / PG&S sub-category) appear **only** under *Purchased Goods and
  Services*; absent everywhere else. The spend paste grid + (B4) CSV import + (B5) portal spend live
  inside that section.
- [ ] Vehicle-registration + manual entry appear **only** under *Company Vehicles* / *Business Travel* /
  *Employee Commuting*; the S1 bulk grids + roll-up live inside those sections.
- [ ] All other categories: plain quantity + unit + monthly only.

### 5. Governed spine, isolation, standards

- [ ] Independent review, provenance/lineage, tenant RLS, CSRF/same-origin (portal), "submitted ≠
  reviewed emissions" — all unchanged.
- [ ] No new migration expected (or an additive `job_categories` table only if Q-UX1-3 = explicit list).
- [ ] "carbon emissions" (NZC-039); dd/mm/yyyy (NZC-040); staging only.

### 6. Flag behaviour (Q-UX1-2)

- [ ] `data-entry-accordion` OFF by default → today's flat register + panels, unchanged. ON → the
  accordion + shared component + site-context. Per-adapter flags still gate their category's rich entry.
  Removing the value instantly restores the flat layout.

### 7. Tests & build

- [ ] `listJobApplicableCategories` (derived scopes, counts, ordering, verbatim names).
- [ ] `<EmissionEntryForm>` unit tests: field order, progressive disclosure per category, monthly
  collapse, portal-constrained mode.
- [ ] Accordion: applicable-only, collapsed default, By category ↔ Needs attention, per-category add.
- [ ] Site-context: auto-allocation on create, override to Unallocated, portal authorised-sites only.
- [ ] Parity: an entry made via the accordion is identical on the wire to today's form for the same
  inputs (regression fixtures for spend / commuting / a plain activity row).
- [ ] `npm run typecheck`, `test:portal`, `test:staff`, contracts + mock-data, `build -w @nzi/console` —
  green. No new runtime dependency.

### 8. Accessibility & responsive

- [ ] Accordion: `aria-expanded` sections, keyboard operable, focus management on expand, one section's
  form reachable at a time; no horizontal overflow 390/768/1280/1920; contrast-safe; reduced-motion.
- [ ] Automated axe + responsive in an e2e spec (skips until the flag is on staging).
- [ ] **Rendered screen-reader pass — human-only** (folds into the #22 / A3 / #25 session, alongside the
  adapter surfaces).

## Exit

All boxes ticked **plus** `docs/STAGING_ACCEPTANCE_UX1.md`. The flip is its own reviewed change after a
rendered acceptance pass.

## Proposed build order (assuming the recommendations)

1. **Docs** — this gate + `DATA_ENTRY_UX.md` + NZC-046 (this PR).
2. **UX1a** — `listJobApplicableCategories` + `<EmissionEntryForm>` (shared, fixed order, progressive
   disclosure), behind `data-entry-accordion`; unit tests.
3. **UX1b** — the CRP accordion container + By category/Needs attention toggle; re-home the CRP adapters
   into their sections; e2e.
4. **UX1c** — site-as-context (CRP + portal) + auto-allocation.
5. **UX1d** — the portal accordion mirror; re-home the portal spend surface.
6. Separate PR: flip `data-entry-accordion` in `render.yaml` (after Q-UX1-1's flips are banked).
7. **UX1.1** — Business Travel capture kind (Q-UX1-4).

*Prepared 1 Sep 2026. Implements NZC-046. Absorbs burndown row S5's data-entry portion; the wider
stage-as-section language (NZC-038) for non-data-entry workspaces remains its own pass.*
