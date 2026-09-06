# Data-entry UX review — acceptance

Origin: Francis's walk of the live data-entry surface (`entry-lean-capture` + `data-entry-fast-add` on),
06 Sep 2026. Hand-off `docs/_handoff_DATA_ENTRY_UX_review.md`; drawer reference
`docs/prototypes/row_drawer_v1.html` (Artifact 91f575f2). Theme: **lead with the data, collapse
everything else, help on demand.** All work behind the existing data-entry flags, e2e + hard-precondition
once live. Build order **1 → 5** (6 is the cross-cutting principle).

| # | Item | Status |
|---|---|---|
| **1** | BUG — the row-detail drawer doesn't update on many Scope 3 / adapter rows | 🟢 built (PR #104) |
| **2** | Rework the row-detail drawer to the prototype (7 key fields + collapsible sections, single column, type-adaptive source section) | 🟢 built (PR #105) |
| **3** | Info icons instead of inline instructions — one shared ⓘ tooltip component, systemic | 🟢 built (PR #105 component, PR #106 roll-out) |
| **4** | "Import & templates" modal per category — methods as tabs, reuse the accessible dialog | 🟢 built (PR #107) — Vehicles / Commuting / PG&S; Business Travel tab lands with item 5 |
| **5** | Business Travel multi-mode entry + consolidation — generalise the per-entity roll-up beyond vehicles/commuting; lean the create-source form | ⚪ next |
| **6** | Noise reduction overall — a category card at rest is just its rows + two actions | ⚪ folded through 2–5 |

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

## Items 5–6

**5 — Business Travel multi-mode + consolidation**: generalise the per-entity roll-up (currently hard-scoped
to Company Vehicles + Employee Commuting) into a capability any many-sub-item category can use; Business
Travel adds trips across modes (flights, rail, hire car, taxi) and consolidates to canonical rows. Lean the
create-source form (core fields inline, detail to the drawer).

**6 — noise reduction**: collapse-by-default across the category panels — a card at rest is its rows plus
"+ Add entry" and "Import & templates".
