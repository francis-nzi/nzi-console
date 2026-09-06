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
| **3** | Info icons instead of inline instructions — one shared ⓘ tooltip component, systemic | 🟡 component built (PR #105); roll-out to the remaining panel blurbs pending |
| **4** | "Import & templates" modal per category (Vehicles, Travel, Commuting, PG&S) — methods as tabs, reuse the accessible dialog | ⚪ next |
| **5** | Business Travel multi-mode entry + consolidation — generalise the per-entity roll-up beyond vehicles/commuting; lean the create-source form | ⚪ planned |
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

## Items 3–6

**3 — shared ⓘ tooltip**: the `InfoTip` component is built and in use in the row drawer (item 2). Remaining:
replace the standing instruction paragraphs elsewhere — `CrpDataEntryAccordion`'s `KIND_NOTE` strip, the
`nz-config-head .sub` blurbs on the adapter panels — with ⓘ, keeping the panels quiet.

**4 — "Import & templates" modal**: one button per category (Company Vehicles, Business Travel, Commuting,
PG&S) opening one large accessible modal (reuse the `Drawer` dialog primitive — focus trap, Esc, return
focus, `aria-modal`), methods as tabs (Paste a list · Download template / Upload CSV · Roll forward for
PG&S). Wide preview scrolls inside the modal. Keep "+ Add entry" and the template search on the page. The
per-entity roll-up register stays on-page / in the drawer, not in the modal.

**5 — Business Travel multi-mode + consolidation**: generalise the per-entity roll-up (currently hard-scoped
to Company Vehicles + Employee Commuting) into a capability any many-sub-item category can use; Business
Travel adds trips across modes (flights, rail, hire car, taxi) and consolidates to canonical rows. Lean the
create-source form (core fields inline, detail to the drawer).

**6 — noise reduction**: collapse-by-default across the category panels — a card at rest is its rows plus
"+ Add entry" and "Import & templates".
