# Data-entry UX review — acceptance

Origin: Francis's walk of the live data-entry surface (`entry-lean-capture` + `data-entry-fast-add` on),
06 Sep 2026. Hand-off `docs/_handoff_DATA_ENTRY_UX_review.md`; drawer reference
`docs/prototypes/row_drawer_v1.html` (Artifact 91f575f2). Theme: **lead with the data, collapse
everything else, help on demand.** All work behind the existing data-entry flags, e2e + hard-precondition
once live. Build order **1 → 5** (6 is the cross-cutting principle).

| # | Item | Status |
|---|---|---|
| **1** | BUG — the row-detail drawer doesn't update on many Scope 3 / adapter rows | 🟢 built (PR #104) |
| **2** | Rework the row-detail drawer to the prototype (7 key fields + collapsible sections, single column, type-adaptive source section) | ⚪ next |
| **3** | Info icons instead of inline instructions — one shared ⓘ tooltip component, systemic | ⚪ planned |
| **4** | "Import & templates" modal per category (Vehicles, Travel, Commuting, PG&S) — methods as tabs, reuse the accessible dialog | ⚪ planned |
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

## Items 2–6

Recorded from the hand-off; specs land with each PR.

**2 — row-detail drawer rework** (`docs/prototypes/row_drawer_v1.html`): 7 key fields always visible (Site ·
Scope · Category · Report label · Quantity · UoM · tCO₂e); everything else in **collapsed-by-default**
sections (Factor & calculation · Data quality · Apportionment & site · Source detail · Monthly activity ·
Evidence & provenance); single column, no horizontal scroll; the **Source detail** section adapts to the
row type (vehicle → reg/make/model/fuel; spend → net/VAT/GL/PG&S category/invoice date). Reuse the
assurance-drawer dialog/focus patterns.

**3 — shared ⓘ tooltip**: one component in `@nzi/ui` replacing the standing instruction paragraphs
(`KIND_NOTE`, the per-panel blurbs). Keyboard-reachable, dismissible (Esc / click-away).

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
