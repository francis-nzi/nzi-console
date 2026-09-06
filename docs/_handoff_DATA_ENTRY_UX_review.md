# Data-entry UX review — brief for Claude Code

**Prepared 06 Sep 2026 (Cowork).** From Francis, walking the live surface with `entry-lean-capture` +
`data-entry-fast-add` flipped on. Theme throughout: **lead with the data, collapse everything else, help on
demand.** Drawer reference prototype: `docs/prototypes/row_drawer_v1.html`
(Artifact https://claude.ai/code/artifact/91f575f2-f4db-4ce7-a62f-c73ec50932eb). Apply on branches + PRs,
behind the existing data-entry flags, with e2e + the hard-precondition-once-live discipline.

Suggested order: **1 → 2 → 3 → 4 → 5**. Items 1 and 2 are what Francis is hitting right now.

---

## 1. BUG — the row-detail drawer doesn't update on many Scope 3 rows
Standard accordion rows call `onOpenRow` (`CrpDataEntryAccordion.tsx:177 / 221 / 287`), but rows rendered by
the re-homed **adapters** (the spend / PG&S register, and other adapter-rendered rows) don't — so clicking a
PG&S "Purchased goods — spend" row (and similar) never changes the drawer. **Wire every displayed row —
adapter/register rows included — to the shared `onOpenRow`** so all of them open the detail drawer. Add an
e2e assertion that clicking a spend row updates the drawer.

## 2. Rework the row-detail drawer  →  `docs/prototypes/row_drawer_v1.html`
Replace the current full-Editor drawer (shows everything at once, horizontal scroll) with the prototype:
- **Key fields always visible:** Site · Scope · Category · Report label · Quantity · UoM · tCO₂e.
- **Everything else in collapsible sections, collapsed by default:** Factor & calculation · Data quality ·
  Apportionment & site · Source detail · Monthly activity · Evidence & provenance.
- **Single column, no horizontal scroll.**
- **Source-detail section adapts to row type** — a vehicle row shows Vehicle detail (reg/make/model/fuel); a
  spend row shows Spend detail / PG&S (net/VAT/GL code/PG&S category/invoice date). This is how the PG&S
  complexity stops being noise — it's one tucked-away, type-specific section.
- Inline field instructions replaced by **ⓘ** icons (see item 3).
- Reuse the dialog/focus patterns fixed for the assurance drawer (Esc, focus management).

## 3. Info icons instead of inline instructions — systemic
Across data entry, replace the standing instruction paragraphs (e.g. "Spend adapter — ledger value, VAT, GL
code & PG&S category…", "DVLA registration lookup or manual entry", the per-panel blurbs) with a small **ⓘ**
that reveals the text on demand. Build **one shared info-icon/tooltip component** and use it everywhere; keep
the panels themselves quiet. Tooltip must be keyboard-reachable and dismissible (Esc / click-away).

## 4. "Import & templates" modal — consolidate the bulk panels (Company Vehicles, Business Travel, Commuting, PG&S)
Today these categories stack several always-open panels — download-CSV-template, paste-a-list, upload-CSV,
and (PG&S) roll-forward + spend-ledger + spend-import — which is most of the vertical noise on the page.
**Consolidate per category into a single "Import & templates" button that opens one modal**, with the methods
as **tabs inside it**:
- **Paste a list** (the bulk paste box + parse),
- **Download template / Upload CSV** (template download + file upload + column-map + row preview),
- **Roll forward last year** (PG&S / spend — copy prior mappings).

Requirements:
- **Large, focused modal** — the spend-import column-map + per-row preview can be wide; the preview table
  **scrolls inside the modal**, the page never scrolls sideways.
- **Reuse the accessible dialog pattern** already built for the assurance drawer — focus trap, **Esc to
  close**, return focus to the trigger, `role="dialog"` + `aria-modal`, a keyboard-reachable close. Do **not**
  hand-roll a new modal.
- **Keep the two lightweight paths on the page:** "+ Add entry" (single row) and the top-of-section template
  search. Only the bulky import/template machinery moves into the modal.
- This is the same solution as the earlier "PG&S consolidation" item, generalised to all four categories, so
  every category card collapses to: its rows → "+ Add entry" → "Import & templates".
- **Keep the per-entity roll-up register OUT of the modal.** Bulk import is a one-shot task (modal fits); the
  roll-up register is ongoing management of groups — it stays on the page (collapsed) or in the drawer.

## 5. Business Travel — multi-mode entry + consolidation (generalise the roll-up)
The per-entity roll-up register is currently hard-scoped to Company Vehicles + Employee Commuting. Generalise
it so **Business Travel** can add many trips across **modes** (flights, rail, hire car, taxi…) and
**consolidate** them into canonical rows the same way. Preferred: make the per-entity/roll-up register a
**general capability** any category with many sub-items can use, rather than a vehicles/commuting special
case. Also lean its create-source form (core fields inline, detail to the drawer) so it isn't a wall of
fields.

## 6. Noise reduction overall
Collapse-by-default, lead with the data, help on demand — the drawer prototype sets the pattern; apply the
same restraint to the category panels so a category card at rest is just its rows and two actions.

---

*Delete this hand-off once the items are in the acceptance docs / register.*
