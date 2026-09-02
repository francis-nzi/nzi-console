# Register additions — hand-off for Claude Code (report decisions + R-track)

**Prepared 01 Sep 2026.** Ready-to-commit wording for the **report** decisions (NZC-048–051) and the
**R-track** burndown. Apply on a branch + PR (do not force onto a live working tree), then delete this
hand-off file.

## Ordering (so the register stays continuous)
Land in this order: **NZC-047** (portal breadth — already on `docs/nzc-046-047-refinements` @ 5fb70d7,
merge it to main first) → **NZC-048–051** (report, below) → **NZC-052–056** (job-family batch = the five
`NZC-0aa..0ee` in `docs/MODEL_FIDELITY_JOB_FAMILIES.md`, renumber them 052–056 in that order). Also flip
**NZC-024** to *Confirmed* with the sequencing note in §D.

---

## A. `DECISIONS.md` — index-table rows (append after the NZC-047 row)

```
| NZC-048 | Editable report sections: ordered, versioned sections with contentSource default/ai/client-edited, Reset-to-default + Regenerate, provenance | Confirmed (01 Sep 2026) |
| NZC-049 | Data-bound figure tokens: figures in report narrative resolve from the report snapshot as locked tokens, never free text — data-integrity survives editing | Confirmed (01 Sep 2026) |
| NZC-050 | Deterministic print-safe charts: report charts render as static inline SVG from the snapshot; one render-ready signal gates PDF; no request-time canvas | Confirmed (01 Sep 2026) |
| NZC-051 | Paged output discipline: repeating table-header groups, row-atomic breaks, live-PDF running header/footer, on-screen Continuous↔A4 page-break view; snapshot frozen on Mark Final | Confirmed (01 Sep 2026) |
```

---

## B. `DECISIONS.md` — detail blocks (append in the Decisions section)

### NZC-048 — Editable report sections [Confirmed 01 Sep 2026]
A report is an ordered list of **versioned** sections, each with a `contentSource` of `default` (the NZI
template wording), `ai` (an AI redraft — the Report Preparation feature generalised to every section) or
`client-edited`. Editing is never a silent overwrite: each section carries provenance (who, when, source)
and the previous version is recoverable, exactly like a scope row. Every section offers **Reset to default**
and **Regenerate (AI)**; a status pill (Default / AI-drafted / Edited by client) is mirrored as a dot in the
section outline. Rich-text editing is scoped to the section body; structural furniture (headings, tables,
charts, sign-off) is not free-text. Editing respects the five UI states (unsaved ≠ saved).
*Source: `docs/REPORT_PRINTING_UX.md` §2; prototype `docs/prototypes/report_v3.html`.*

### NZC-049 — Data-bound figure tokens [Confirmed 01 Sep 2026]
Figures embedded in report narrative are **not free text** — they are data-bound tokens resolved from the
report snapshot at render time (rendered as locked chips; the surrounding wording stays fully editable).
Consequence: the "Data integrity check passed" guarantee **survives arbitrary prose editing** — a client can
rewrite the Executive Summary and every figure still equals the canonical total — and a re-snapshot updates
the numbers with no re-typing and no stale figures. Tokens come from a fixed palette (total, scope
subtotals & %, category totals, intensity metrics, target %s, dates in dd/mm/yyyy), the same catalogue the
AI drafter draws from, so AI text is data-bound by construction. The report-side counterpart of the
data-entry governance spine: numbers have one source of truth.
*Source: `docs/REPORT_PRINTING_UX.md` §3.*

### NZC-050 — Deterministic print-safe charts [Confirmed 01 Sep 2026]
Report charts render as **static inline SVG**, each a pure function of the frozen report snapshot — no
canvas, no chart library at render time, no network, no post-load layout. Fixes the recurring PDF breakage,
whose root cause is the PDF pipeline racing a client-side canvas render (half-drawn / zero-sized / size
mismatch). The PDF step waits on **one** deterministic render-ready signal (a `data-report-ready` flag set
once all sections and SVGs are in the DOM) — no arbitrary sleeps. Charts read from the same snapshot as the
tables, so a chart can never disagree with a table, and the data-integrity banner extends to cover charts.
Charts use the canonical `@nzi/charts` palette (Scope 1 coral / Scope 2 amber / Scope 3 emerald).
*Source: `docs/REPORT_PRINTING_UX.md` §1; `report_v3.html` (`donut()`, `bars()`, `pathway()`).*

### NZC-051 — Paged output discipline + running header/footer [Confirmed 01 Sep 2026]
Long tables use paged-media CSS so the header **group repeats on every page** a table spans
(`thead{display:table-header-group}`, `tr{break-inside:avoid}`, explicit `break-before`/`break-after`). The
surface offers a **Continuous ↔ Page view (A4)** toggle whose on-screen page map matches the generated PDF;
Continuous draws a "Page N break" marker at every boundary. Every page except the cover carries the live
PDF's running header (centred: client name over "Carbon Reduction Plan · <reporting period>") and footer
("Net Zero International" · job number · page number); header dates follow NZC-040 (dd/mm/yyyy) — the one
deliberate change from the live PDF's abbreviated-month format. On "Mark Final" the report version's
numbers, section text versions and chart source data are frozen together into one content-addressed
snapshot, so a re-print is byte-reproducible and an independent reviewer is bound to exactly what was signed
off. Production pagination uses a paged-media engine (server-side Chromium print, or a Paged.js-style
preview) so screen and PDF agree exactly.
*Source: `docs/REPORT_PRINTING_UX.md` §4–§5.*

---

## C. `REDESIGN_ROLLOUT.md` — Report Studio track (add to the Burndown)

### M7 · Report Studio (R-track) — Report → Report Printing redesign
Spec: `docs/REPORT_PRINTING_UX.md` (NZC-048–051). Reference prototype:
`docs/prototypes/report_v3.html`. Each slice ships behind its own flag with a rendered acceptance pass,
same discipline as the data-entry adapters. Sequenced after the data-entry tracks (UX1 + adapters).

| Slice | Scope | Flag | Status |
|---|---|---|---|
| R1 | Print-safe chart pack — report charts to deterministic SVG from the snapshot + single render-ready signal (kills the PDF breakage) | `report-svg-charts` | ⏳ queued |
| R2 | Section model + provenance — ordered versioned sections, `contentSource`, Reset-to-default (backend/model; no new editing UI) | `report-sections` | ⏳ queued |
| R3 | Data-bound figure tokens — token catalogue + resolver + locked-chip renderer; extend the data-integrity banner to charts + tokens | `report-tokens` | ⏳ queued |
| R4 | In-place section editing + Regenerate — rich-text scoped to section bodies; generalise Report Preparation AI to every section | `report-edit` | ⏳ queued |
| R5 | Paged preview + repeating headers + running header/footer — Continuous/Page-view toggle, paged-media CSS, live-PDF header/footer, page-break markers | `report-paged` | ⏳ queued |

> R1 alone permanently removes the PDF-breakage problem and is the recommended first slice. R4/R5 are the
> client-facing pieces; hold client exposure until their rendered acceptance passes.

---

## D. Also flip NZC-024 to Confirmed
Mark **NZC-024** (job-family modularization) *Confirmed (01 Sep 2026)* with: families become first-class
workspace modules over the shared spine; the generic `FamilyWorkspace.tsx` ternary is retired; **prove the
model first** per non-CRP family (the batch in `MODEL_FIDELITY_JOB_FAMILIES.md`), then **one LCA reference
module** behind a flag, prove, replicate. **Phase 0 (migrations + fixtures + invariants) proceeds now; the
LCA reference module waits until the report (R-track) and data-entry tracks land.** The five batch decisions
become **NZC-052–056** (= `NZC-0aa..0ee` in that doc, in order), with these confirmations folded in:
PCF preset keeps the "Product Carbon Footprint" label per NZC-039; free training places originate from the
quote/commercial terms (manual CRP grant secondary), always via the `training_entitlements` row;
consultancy stays light (no time-tracking engine).
