# A11y shared building blocks — Tabs · Drawer · GatedButton · acceptance

Origin: the **Data Assurance human pass** (`data-assurance` is live on staging — in front of consultants
now) surfaced three keyboard / screen-reader defects in `apps/console/app/jobs/CrpAssuranceStage.tsx`:

1. **Tablist had no arrow-key navigation** (WCAG 2.1.1 / WAI-ARIA tabs). `role="tablist"` + `role="tab"`
   markup with no keyboard handler and no roving tabindex.
2. **The assurance drawer could not be closed by keyboard and did nothing with focus** (WCAG 2.1.2 / 2.4.3).
   An overlay panel (`position: fixed`) rendered as `role="complementary"`, no Escape, no focus move in on
   open, no focus restore on close.
3. **The sign-off button was unreachable because it was `disabled`** (WCAG 4.1.2 / the gated-action
   pattern). A keyboard / SR user could neither focus it nor hear *why* it was blocked.

These three shapes — a **tablist**, an **overlay drawer**, a **gated primary button** — recur across the
report surfaces and the new LCA module. Fixing them per-surface guarantees the same three findings in every
future human pass. So they are fixed **once, as shared primitives in `@nzi/ui`**, and the surfaces are
retrofitted onto them.

## The primitives (`packages/ui/src/`)

### `Tabs.tsx` — `Tabs` + `TabPanel`

The WAI-ARIA "tabs with automatic activation" pattern.

- **Roving tabindex**: the selected tab is the only tab stop (`tabIndex=0`); the rest are `-1`, so <kbd>Tab</kbd>
  moves *out* of the tablist, not between tabs.
- <kbd>←</kbd>/<kbd>→</kbd> (and <kbd>↑</kbd>/<kbd>↓</kbd>) move focus **and** activate, wrapping.
  <kbd>Home</kbd>/<kbd>End</kbd> jump to the first/last **enabled** tab.
- Each tab: `role="tab"`, `id="{idBase}-tab-{id}"`, `aria-controls="{idBase}-panel-{id}"`, `aria-selected`,
  `aria-disabled` when disabled, `className="on"` when selected (existing CSS unchanged).
- `TabPanel`: `role="tabpanel"`, matching `id` / `aria-labelledby`, `tabIndex=0` (keyboard user lands on the
  content), `hidden` when inactive, children only mounted when active (so an inactive panel is cheap but its
  element still exists — `aria-controls` always resolves, which axe requires).

### `Drawer.tsx` — `Drawer`

A dismissible **overlay** (the assurance-drawer kind — *not* the always-visible `EvidenceDrawer`
`complementary` region, which is deliberately left alone).

- `role="dialog"` + `aria-modal="true"` + an accessible name (`ariaLabel`).
- On open: focus moves to the first focusable inside (or the dialog itself).
- <kbd>Esc</kbd> closes (captured, `stopPropagation` so it doesn't also collapse the parent stage).
- <kbd>Tab</kbd> / <kbd>Shift+Tab</kbd> cycle **within** the drawer while open — a deliberate, escapable
  trap (WCAG 2.1.2 done right, not violated).
- On close: focus returns to the opener **if it is still in the document**. A conditionally-rendered opener
  (the assurance "reopen" button unmounts while the drawer is open) is restored by the caller once it
  re-mounts (`reopenRef` + a `closedByUser` ref in `AssuranceSurface`).
- The caller supplies a keyboard-reachable close control inside `children`.

### `GatedButton.tsx` — `GatedButton`

The gated-action pattern for a **persistent** block (a reason the user can act on — not a transient
"…saving", for which a plain `disabled` is still correct).

- `aria-disabled="true"` while `blocked` (stays focusable) instead of the native `disabled` attribute.
- `onClick` is guarded — a no-op while blocked.
- `blockedReason` renders next to the button **and** is wired via `aria-describedby`, so a keyboard / SR
  user reaches the button and hears e.g. "Blocked: 2 integrity gaps · 1 row awaiting review".
- Visual dimmed state is unchanged — CSS now also targets `[aria-disabled="true"]`
  (`.nz-btn[aria-disabled="true"]`, `[role="tab"][aria-disabled="true"]`).

## Retrofits

| Surface | File | Change |
|---|---|---|
| **Data Assurance** (the human-pass origin) | `apps/console/app/jobs/CrpAssuranceStage.tsx` | main 5-view tablist → `Tabs` + `TabPanel`×5; the overlay → `Drawer` (`role="dialog"`, Esc, focus mgmt) with its inner Gaps / Row-detail segment → nested `Tabs`; `SignOffPanel` sign-off + `RowReview` Reject/Approve → `GatedButton`; `reopen` focus-restore logic |
| **Report view toggle** | `apps/console/app/reports/[versionId]/ReportPagedView.tsx` | Continuous / Page view · A4 toggle → `Tabs`; the two view containers carry `role="tabpanel"` + `aria-labelledby` |
| **LCA module** | `apps/console/app/jobs/lca/LcaWorkspace.tsx` | `AssessmentResults` Approve / Reject / Freeze-snapshot → `GatedButton` (each with its own blocked-reason: "already approved", "enter a reviewer note", "approve before freezing") |
| **CRP data-entry accordion** | `apps/console/app/jobs/CrpDataEntryAccordion.tsx` | "By category" / "Needs attention" lens switch → `Tabs` + `TabPanel`×2 (both panels always in the DOM so `aria-controls` resolves; inactive panel's children unmounted) |

`PortalWorkspace.tsx` already implements roving tabindex + `moveTab` by hand and is **not** broken —
left as-is (a later consistency pass can move it onto `Tabs`).

## Regression guard — `apps/console/tests/e2e/a11y-primitives.spec.ts` (new)

Three interaction tests, exercised on the live `data-assurance` surface (these are behaviours axe cannot
assert):

| # | Test | Asserts |
|---|---|---|
| 1 | **Tabs: roving tabindex + Arrow/Home/End move and activate; Tab leaves the tablist** | selected tab `tabindex=0` / others `-1`; <kbd>→</kbd> focuses + activates the next tab and reveals its `role="tabpanel"`; <kbd>End</kbd>/<kbd>Home</kbd> jump; <kbd>Tab</kbd> does not land on the next tab |
| 2 | **Drawer: role=dialog, Escape closes it, focus returns to the opener** | `role="dialog"` + `aria-modal="true"`; keyboard-reachable close; reopen via the focusable reopen button + <kbd>Enter</kbd>; focus is inside the drawer; <kbd>Esc</kbd> closes and restores focus to the reopen button |
| 3 | **GatedButton: sign-off is aria-disabled (not disabled), focusable, describes why** | not `[disabled]`; `aria-disabled="true"`; stays in the tab order (`toBeFocused`); `aria-describedby` resolves to text containing the blocked reason |

`data-assurance.spec.ts` updated for the new markup: the "disabled" assertions on the sign-off / approve
buttons now check `aria-disabled` (the button is intentionally *not* natively disabled); the "By site"
panel assertion is scoped to the visible `role="tabpanel"` (all five panels are now always in the DOM).

## Gate

| # | Item | Check |
|---|---|---|
| 1 | `Tabs` implements roving tabindex + Arrow/Home/End with automatic activation; `Tab` exits the tablist | `a11y-primitives.spec.ts` #1 |
| 2 | `Drawer` is `role="dialog"` + `aria-modal`, Escape-closable, moves focus in on open and restores it on close, traps Tab while open | `a11y-primitives.spec.ts` #2; `Drawer.tsx` review |
| 3 | `GatedButton` stays focusable while blocked, is not natively `disabled`, and points `aria-describedby` at its reason | `a11y-primitives.spec.ts` #3 |
| 4 | Every retrofitted surface keeps its existing look (CSS classes unchanged; `aria-disabled` picks up the same dimmed style) | code review + `npm run build` |
| 5 | No new axe violations — inactive `role="tabpanel"` elements are `hidden`; `aria-controls` always resolves | `accessibility.spec.ts` / `scanWithBaseline` on the accordion + data-assurance surfaces (hard once their flags are live — unchanged discipline) |
| 6 | `data-assurance.spec.ts` still green against the new markup | updated in this PR |
| 7 | `npm run typecheck` (all workspaces) · `@nzi/console` build · full unit suites green | ✅ |

## Verification

- `npm run typecheck` (all workspaces) — clean.
- `npm run build -w @nzi/console` — green (`✓ Compiled successfully`).
- `npm run test -w @nzi/console` — **121 / 121**.
- `a11y-primitives.spec.ts` (3) + the updated `data-assurance.spec.ts` run against deployed staging on the
  next rendered-acceptance pass (`data-assurance` is already live; no new flag).

## Not in scope

- A visual/AT sensory pass (NVDA / VoiceOver) — Francis's gate, unchanged.
- Moving `PortalWorkspace.tsx` onto `Tabs` (already accessible; consistency-only).
