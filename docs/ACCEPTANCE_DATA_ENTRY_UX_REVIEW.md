# Data-entry UX review — acceptance

Origin: Francis's walk of the live data-entry surface (`entry-lean-capture` + `data-entry-fast-add` on),
06 Sep 2026 (hand-off since deleted — its six items are recorded here). Drawer reference
`docs/prototypes/row_drawer_v1.html` (Artifact 91f575f2). Theme: **lead with the data, collapse
everything else, help on demand.** All work behind the data-entry flags, e2e + hard-precondition once
live. Built in order 1 → 5; 6 is the cross-cutting principle.

| # | Item | Status |
|---|---|---|
| **1** | BUG — the row-detail drawer doesn't update on many Scope 3 / adapter rows | 🟢 built (PR #104) |
| **2** | Rework the row-detail drawer to the prototype (7 key fields + collapsible sections, single column, type-adaptive source section) | 🟢 built (PR #105) |
| **3** | Info icons instead of inline instructions — one shared ⓘ tooltip component, systemic | 🟢 built (PR #105 component, PR #106 roll-out) |
| **4** | "Import & templates" modal per category — methods as tabs, reuse the accessible dialog | 🟢 built (PR #107) — Vehicles / Commuting / PG&S; Business Travel tab lands with item 5 |
| **5** | Business Travel multi-mode entry + consolidation — generalise the per-entity roll-up beyond vehicles/commuting; lean the create-source form | 🟢 built (PR #108) — behind new flag `travel`; migration 0057 applied to staging; **needs the Render dashboard flip** |
| **6** | Noise reduction overall — a category card at rest is just its rows + two actions | 🟢 delivered through 2–5 |

---

## Item 1 — every displayed row opens the shared detail drawer

**Root cause.** The right-hand `EvidenceDrawer` shows `resolveSelectedScopeRow(...)`, which resolved the
selected id against the **flat register's currently-filtered `visibleRows`** first, with a fallback to
`visibleRows[0]`. The flat register defaults to the `"attention"` filter (`scopeRowNeedsAttention` — not
calculated, or no quality tier, or not approved). So clicking a **calculated + independently-approved**
row in the category accordion — which is *not* "needs attention" — missed `visibleRows`, fell through to
`visibleRows[0]`, and the drawer snapped to the first attention row instead of the row you clicked. Every
"healthy" row (spend / PG&S included) was un-openable from the accordion.

**Fix.**
- `apps/console/app/jobs/scopeRegister.ts` — new pure `resolveSelectedScopeRow(rows, visibleRows,
  selectedId)`: resolve against the **whole** register first (`rows.find(id)`), then `visibleRows[0]`,
  then `rows[0]`. `CrpScopeWorkspace.tsx` uses it in place of the inline `visibleRows.find(...) ??
  visibleRows[0] ?? ...` expression.
- `apps/console/app/jobs/EmissionSourceRegister.tsx` — the per-entity ("spend / PG&S") register now takes
  an optional `onOpenRow`; a **synced** source renders its name as a link-style button
  (`.nz-linkish`, new shared style in `@nzi/ui`) that opens its canonical scope row in the same drawer.
  An unsynced source stays plain text (there is no row to open yet).
- `CrpScopeWorkspace.tsx` passes `onOpenRow={setSelectedId}` to `EmissionSourceRegister`.

The standard accordion rows (`CrpDataEntryAccordion.tsx` attention / category / unsorted tables) were
already wired to `onOpenRow` — the defect was purely in how the target was resolved.

### Gate (item 1)

| # | Check | Where |
|---|---|---|
| 1 | `resolveSelectedScopeRow` opens a row that is filtered out of the flat register; empty selection falls back to first visible then first row; empty register → undefined | `scopeRegister.test.ts` (+1) |
| 2 | A calculated + approved category row opens in the drawer (drawer `h3` = that row's source label; row gets `.sel`), not the first attention row | `row-drawer.spec.ts` #1 |
| 3 | A synced per-entity source opens its canonical row in the drawer | `row-drawer.spec.ts` #2 |
| 4 | Flag OFF (`data-entry-accordion`) unchanged; the flat register path still resolves the same way (now via the shared helper) | code review + unit test cases |
| 5 | `npm run typecheck` (all workspaces) · `@nzi/console` build · unit suites green | ✅ |
| 6 | **Hard precondition once `data-entry-accordion` is live** — `row-drawer.spec.ts` skips only on the public-smoke gate and the target job's data state (no calculated+approved row / no synced source) | `row-drawer.spec.ts` |

### Verification (item 1)

- `npm run typecheck` (all workspaces) — clean.
- `npm run build -w @nzi/console` — green.
- `npm run test -w @nzi/console` — **122 / 122** (+1 `scopeRegister.test.ts`).
- `row-drawer.spec.ts` (2) runs on the next rendered-acceptance pass against deployed staging.

---

## Item 2 — row-detail drawer reworked to the prototype

`docs/prototypes/row_drawer_v1.html`. The old drawer rendered the whole `Editor` at once (a flat 3-col
`nz-scope-fields` grid that scrolled sideways, plus lineage / provenance / review / history / snapshot
stacked below). Reworked:

- **`@nzi/ui/Collapsible`** (new) — a lean collapsed-by-default disclosure (`aria-expanded` header +
  `hidden` region, children mounted only when open). Uncontrolled by default; accepts `open` +
  `onOpenChange` for the "History" footer button to open one section. Distinct from `StageSection`.
- **`@nzi/ui/InfoTip`** (new, also item 3) — one ⓘ button + popup. Keyboard-reachable (`<button>`),
  toggles on click/Enter/Space, dismisses on Escape or an outside pointer/focus. Text is always in the DOM
  (CSS-clipped when closed) so `aria-describedby` works for a screen reader without opening it.
- **`apps/console/app/jobs/rowSourceDetail.ts`** (new, pure) — `rowSourceDetail(row)` returns the
  type-adaptive **Source detail** section: `Vehicle detail` (reg / make / model / fuel, from
  `provenance.detail`), `Spend detail (PG&S)` (net / VAT / GL / PG&S category / invoice ref, from
  `provenance.detail | provenance.spendDetail`; the row's PG&S label wins over the frozen one), or a
  generic `Source detail`. Empty fields are dropped.
- **`Editor`** (`CrpScopeWorkspace.tsx`) rebuilt: a status banner, then the **7 always-visible key
  fields** (`.nz-rd-keys` — Site · Scope · Category · Report label · Quantity · UoM · tCO₂e), then six
  **collapsed-by-default** `Collapsible` sections — Factor & calculation · Data quality · Apportionment &
  site · {Source detail — adaptive title} · Monthly activity · Evidence & provenance (lineage,
  provenance, the client-factor-moved note, independent review as `GatedButton`s, activity history,
  reporting snapshot). A sticky footer: **Save · Calculate · History**. Single column
  (`.nz-rd .nz-scope-fields{grid-template-columns:1fr}`), `overflow-wrap:anywhere` on provenance values —
  no horizontal scroll. Inline instruction paragraphs replaced by ⓘ (Factor set · Reasoned override ·
  Data confidence · Apportionment · Report label · PG&S category).
- The lineage / provenance blocks the drawer wrapper rendered after `<Editor/>` moved **into** the
  Evidence & provenance section.

### Gate (item 2)

| # | Check | Where |
|---|---|---|
| 1 | `rowSourceDetail` adapts to vehicle / spend / generic; PG&S label beats the frozen category; empty fields dropped; a 3.1 row with no frozen detail still shows the PG&S section | `rowSourceDetail.test.ts` (5) |
| 2 | The 7 key fields render, in order, always visible | `row-drawer.spec.ts` — "7 key fields" |
| 3 | Every other section is collapsed on open (`aria-expanded="false"`); the drawer does not scroll horizontally | `row-drawer.spec.ts` — "7 key fields" |
| 4 | A section expands on click; its ⓘ opens on click and closes on Escape | `row-drawer.spec.ts` — "section expands / tooltip" |
| 5 | A Purchased Goods & Services row shows the "Spend detail (PG&S)" section | `row-drawer.spec.ts` — "Source detail adapts" |
| 6 | Save / Calculate / review / snapshot / history all still work (same commands, same endpoints — only the layout changed) | code review + `@nzi/console` build |
| 7 | `npm run typecheck` (all workspaces) · build · unit suites green | ✅ |

### Verification (item 2)

- `npm run typecheck` (all workspaces) — clean · `npm run build -w @nzi/console` — green.
- `npm run test -w @nzi/console` — **126 / 126** (+5 `rowSourceDetail.test.ts`; `rowSourceDetail.test.ts`
  added to the `test` script).
- `row-drawer.spec.ts` (6) runs on the next rendered-acceptance pass.

---

## Item 3 — ⓘ instead of standing instruction paragraphs (systemic)

The `InfoTip` component (built in item 2) rolled out across the staff data-entry surface:

- `CrpDataEntryAccordion` — the always-visible `.nz-acc-kindnote` "⌁ …" strip inside every expanded
  category is removed; the same text is now an ⓘ next to "+ Add entry".
- The re-homed adapter panels drop their `<div className="sub">…</div>` head blurb for an ⓘ on the panel
  title: `SpendLedgerAdapter`, `SpendImportPanel`, `SpendRollforwardPanel`, `CommutingBulkPanel`,
  `VehicleBulkPanel`, `EmissionSourceRegister`.
- Not touched: the client **portal** accordion (`PortalDataEntryAccordion`) keeps its kind-note — a
  different audience and surface; the Setup-stage config panels (Target / Intensity / Site / PG&S /
  Client factor) — Setup, not data entry.

### Gate (item 3)

| # | Check | Where |
|---|---|---|
| 1 | `InfoTip` is keyboard-operable (`<button>`, toggles on Enter/Space) and dismisses on Escape / outside click; the tip text is always in the a11y tree (`aria-describedby`) | `row-drawer.spec.ts` — "section expands / tooltip"; `InfoTip.tsx` review |
| 2 | The accordion's `.nz-acc-kindnote` strip is gone; an ⓘ sits in the category foot instead | `row-drawer.spec.ts` — "category kind-note is an ⓘ" |
| 3 | Adapter panels render an ⓘ in the head, no `.sub` blurb | code review + build |
| 4 | `npm run typecheck` · build · unit suites green | ✅ |

### Verification (item 3)

- `npm run typecheck` (all workspaces) — clean · `npm run build -w @nzi/console` — green ·
  `npm run test -w @nzi/console` — 126 / 126.

---

## Item 4 — "Import & templates" modal per category

The bulk panels (`SpendRollforwardPanel`, `SpendLedgerAdapter`, `SpendImportPanel` for PG&S;
`CommutingBulkPanel`; `VehicleBulkPanel`) stacked always-open in each category card body — most of the
card's vertical noise. Now one **"Import & templates"** button per category opens them in a modal.

- **`@nzi/ui/Drawer`** gains `dismissOnOutsideClick` — a pointer-down directly on the dialog root (used as
  the centered-modal backdrop) closes it. Escape and the ✕ already close; focus still traps + restores.
- **`CrpScopeWorkspace.categoryImport(category)`** replaces `categoryExtras` — returns `{ title, body } |
  null`. For PG&S the `body` is `<ImportMethods>` (a local `Tabs` + `TabPanel` wrapper): **Paste a list**
  (`SpendLedgerAdapter`) · **Download template / Upload CSV** (`SpendImportPanel`) · **Roll forward last
  year** (`SpendRollforwardPanel`), each tab only present if its flag is on. Commuting / Vehicles have a
  single method, so no tab strip. `null` when no adapter flag is on → no button.
- **`CrpDataEntryAccordion`** renders the "Import & templates" button in `.nz-acc-foot` when
  `categoryImport(category)` is non-null, and one `<Drawer className="nz-import-modal">` at the section
  root holding the active category's `body`. The `.nz-import-modal` root is the dim backdrop + centering;
  `.nz-import-modal-card` (`max-height:90vh`, internal scroll) holds a header (title + ✕) and the body.
  Wide preview tables keep their own `overflow-x:auto` — they scroll inside the modal, the page never does.
- Untouched, as the brief requires: **"+ Add entry"** (per category) and the **template search**
  (`TemplateSearchBar`, top of the surface) stay on the page; the **per-entity roll-up register**
  (`EmissionSourceRegister`) stays on the page (it was never in `categoryExtras`).
- The legacy pre-accordion surface keeps the panels inline (that path is being retired).

### Gate (item 4)

| # | Check | Where |
|---|---|---|
| 1 | The bulk panels are no longer in the always-open card body; an "Import & templates" button is | `accordion.spec.ts` — "re-homed adapters … modal" |
| 2 | The button opens a `role="dialog"` + `aria-modal` modal; PG&S shows the three methods as tabs, each revealing its panel | same |
| 3 | Escape closes the modal and returns focus to the trigger; ✕ closes it | same |
| 4 | The adapter a11y specs still reach their grids (through the modal on the accordion surface, inline on the legacy one) | `spend-adapter.spec.ts` · `commuting-bulk.spec.ts` · `vehicle-bulk.spec.ts` via `lib/importModal.ts` |
| 5 | No new flag — reuses `spend` / `spend-import` / `commuting` / `vehicle` | code review |
| 6 | `npm run typecheck` · build · unit suites green | ✅ |

### Verification (item 4)

- `npm run typecheck` (all workspaces) — clean · `npm run build -w @nzi/console` — green ·
  `npm run test -w @nzi/console` — 126 / 126.
- `accordion.spec.ts` + the three adapter specs run on the next rendered-acceptance pass.

---

## Item 5 — Business Travel joins the per-entity roll-up

The per-entity register (`EmissionSourceRegister`) was hard-scoped to Company Vehicles + Employee Commuting
(`addKinds`). **Business Travel** now joins as a third kind — many trips across modes (flight / rail / hire
car / taxi …) roll up into one canonical **Scope 3.6** row, the same mechanism the other two already use
(add sources → group → roll up). Per Francis: minimal "add `travel` as a third kind", **new `travel`
flag**.

- **`@nzi/contracts`** — `EmissionSourceKind += "travel"`; new `TravelDetail` (`{ kind:"travel";
  travelMode; origin; destination; carrier; distanceUnit; passengers }`) in `EmissionSourceDetail`; the
  `emission.source.create` validator accepts `travel` (the existing `detail.kind === sourceType` check
  covers the rest).
- **Migration `0057_emission_source_travel_kind.sql`** — widens the `job_emission_sources.source_type`
  CHECK to `('asset','vehicle','commuting','spend','travel')`. `DROP CONSTRAINT IF EXISTS` + re-`ADD` —
  idempotent. **Applied to isolated staging** (re-run verified) — Render dashboard flip of `travel` still
  needed before its e2e hardens.
- **`@nzi/isolated-backend`** — `syncEmissionSourceToScope`: the existing `/^3\.\d+$/` branch already maps
  scope `3.6` → category code `3.6`, so no sync-logic change; only the inline `source_type` row type
  widened. The group roll-up is kind-agnostic already.
- **`apps/console`** — `featureFlags.ts` `DataEntryAdapter += "travel"`. `EmissionSourceRegister`:
  `travelOn` → `addKinds` includes `travel`; `kindLabel.travel`; `travelModes` list; `Draft` +
  `blank()` + `buildDetail` travel branch; `scopeForKind(kind)` (`vehicle`→1, `travel`→3.6, else 3.7)
  replaces the inline vehicle/commuting ternaries; a travel field block (mode · from · to · carrier ·
  passengers · distance unit) in the create form. `rowSourceDetail.ts` gains a **"Travel detail"** branch
  (mode / leg / carrier / passengers) so the item-2 drawer adapts for a travel row; the drawer's
  reference-field label follows suit.
- The import-modal (item 4) does **not** get a Business Travel tab — travel entry is the roll-up register,
  which stays on the page (there is no BT bulk-paste adapter).
- **Form leaning** (brief: "lean its create-source form") — the travel block is kept compact; a fuller
  pass that moves per-kind detail out of the register's flat grid into the row drawer for *all* kinds is
  deferred (bigger refactor, out of the "add travel as a third kind" scope Francis chose).

### Gate (item 5)

| # | Check | Where |
|---|---|---|
| 1 | `emission.source.create` validates a `travel` source; `detail.kind` must match; `travel` is not rejected as an invalid `sourceType` | `commands.test.ts` (+1) |
| 2 | `rowSourceDetail` adapts to a travel row — mode / leg / carrier / passengers / ref | `rowSourceDetail.test.ts` (+1) |
| 3 | Migration 0057 widens the CHECK, is idempotent, applied to staging | migration file + `apply-migration.mjs` run (×2) |
| 4 | The register offers a "Business travel" kind; picking it sets Scope 3.6 and shows the trip fields | `business-travel.spec.ts` — **flag-skips until `travel` is live; harden at the flip PR** |
| 5 | Sync of a travel source lands a Scope 3.6 canonical row (no category-code change needed) | code review — the `/^3\.\d+$/` branch |
| 6 | `npm run typecheck` (all workspaces) · build · unit suites green | ✅ |

### Verification (item 5)

- `npm run typecheck` (all workspaces) — clean · `npm run build -w @nzi/console` — green.
- `@nzi/contracts` — 75 / 75 (+1). `@nzi/console` — 127 / 127 (+1). `@nzi/isolated-backend` — 329 / 329.
- Migration 0057 applied + idempotency-verified against isolated staging.
- **Open — Francis:** add `travel` to the Render `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` value + rebuild, then
  a flip PR removes the `business-travel.spec.ts` flag skip (same discipline as data-assurance / R5).

---

## Item 6 — noise reduction

Delivered through items 2–5, not a separate change: the row drawer leads with 7 key fields and collapses
the rest (item 2); the standing instruction paragraphs are gone (item 3); the bulk import/template
machinery is behind one button (item 4). A category card at rest is now its rows + **"+ Add entry"** +
**"Import & templates"**.
