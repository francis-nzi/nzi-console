# Report Printing / Report Studio — UX & architecture spec

**Status:** proposed (01 Sep 2026). Companion to `DATA_ENTRY_UX.md`. Reference prototype:
`docs/prototypes/report_v3.html` (published Artifact:
https://claude.ai/code/artifact/d3dd74a6-5031-471a-bde6-5cfa0cefdf6f).

Covers the live **Jobs → Report → Report Printing** surface (e.g. `/jobs/556/advanced-reports`,
"First Event Carbon Reduction Plan"). Four problems drive this redesign; each has a concrete fix below.

> Standards inherited: NZC-039 ("carbon emissions", not "carbon footprint", except the PCF module);
> NZC-040 (all dates dd/mm/yyyy). The cover and metadata in the prototype already use dd/mm/yyyy.

---

## The four problems → the fixes

1. **The PDF keeps breaking on the graphics.** → §1 Print-safe deterministic charts.
2. **Text is mostly static; clients want to edit it throughout.** → §2 Editable sections.
   (with the figures inside that text staying correct → §3 Data-bound figure tokens.)
3. **Tables spill past a page and lose their header row.** → §4 Paged output discipline.
4. **You can't see where the pages break in report view.** → §4 On-screen page-break preview.

---

## 1. Print-safe charts (deterministic SVG)

**Root cause of the breakage:** the charts are rendered client-side (canvas/JS charting) and the PDF
pipeline races the render — sometimes it captures a half-drawn or zero-sized canvas, sometimes a
different size than on screen, so output is inconsistent and occasionally fails the page.

**Rule:** every report chart is a **pure function of the report snapshot** and is emitted as **static
inline SVG** — no canvas, no chart library at render time, no network, no post-load layout. The donut,
the activity bars, the reduction-pathway line and the YoY bars are all deterministic SVG built from the
same numbers the tables use. Because the SVG is in the DOM as markup, the PDF renderer captures it with
no timing dependency, and screen and print are pixel-identical.

- One **deterministic render-complete signal** (a `data-report-ready` flag set once all sections + SVGs
  are in the DOM) is the *only* thing the PDF step waits on. No arbitrary sleeps.
- Charts read from the **frozen snapshot** (see §5), so a chart can never disagree with a table, and the
  existing "Data integrity check passed — all totals, categories and rows match Outputs" banner extends
  to cover charts too.
- Charts carry a visible **"SVG · print-safe"** marker in-app so consultants know the print-hardened
  path is in use.

The prototype builds the donut (three scope segments) and the activity bars this way; view source in
`report_v3.html` (`donut()`, `bars()`).

---

## 2. Editable sections

Today the narrative is static except for a couple of AI-assisted fields in **Report Preparation**.
Clients want to edit **any** section. The model:

A report is an **ordered list of sections**. Each section has a `contentSource`:

- `default` — the standard NZI template wording (what ships today, seeded per section);
- `ai` — an AI redraft (the Report Preparation feature, generalised to every section);
- `client-edited` — a consultant/client has edited the text.

Every section is **versioned with provenance** (who, when, source) exactly like a scope row — editing is
never a silent overwrite, and the previous version is recoverable. Two always-available actions per
section: **Reset to default** (restore template wording) and **Regenerate (AI)** (redraft, still editable
afterwards). A status pill shows the current source (Default template / AI-drafted / Edited by client),
mirrored as a dot in the section outline so the whole report's edit state reads at a glance.

Rich-text editing is scoped to the section body; structural furniture (headings, tables, charts, the
sign-off block) is not free-text. Editing state respects the five explicit UI states — an unsaved edit is
a distinct state from saved.

---

## 3. Data-bound figure tokens (the invariant that makes §2 safe)

The danger in letting clients edit prose is that a figure typed into a sentence ("108.15 tCO₂e") drifts
from the data. **Fix:** figures embedded in narrative are **not free text** — they are **data-bound
tokens** resolved from the report snapshot at render time. A token renders as a locked chip inside the
prose (the prototype shows them as green, lock-marked chips with a "bound to Outputs — updates
automatically, cannot be mistyped" tooltip). The surrounding wording is fully editable; the token is
`contenteditable="false"` and cannot be altered or deleted mid-word by ordinary typing.

Consequences:

- The **data-integrity guarantee survives editing.** A client can rewrite the Executive Summary
  entirely and every figure in it still equals the canonical total — the banner stays green.
- If the underlying data changes and the report is re-snapshotted, the prose updates its numbers with no
  re-typing and no stale figures.
- Tokens are inserted from a small palette (total, scope subtotals & %, category totals, intensity
  metrics, target %s, dates in dd/mm/yyyy) — the same catalogue the AI drafter draws from, so AI text is
  data-bound by construction.

This is the report-side counterpart of the data-entry governance spine: numbers have one source of truth.

---

## 4. Paged output — repeating headers, clean breaks, visible page breaks

**Repeating table headers (problem 3):** long tables (Appendix 1 Full Emissions Audit, Appendix 2,
category breakdowns) use paged-media CSS so the header **group repeats on every page** a table spans:
`thead { display: table-header-group; }`, rows kept atomic with `tr { break-inside: avoid; }`, and
section starts controlled with `break-before`/`break-after`. The prototype demonstrates the intent: in
Page view the audit table crosses a page boundary and the header row reappears at the top of the
continuation page (labelled "header repeats each page").

**On-screen page breaks (problem 4):** the surface has a **view toggle**:

- **Continuous** — a comfortable editing width with a dashed **"Page N break"** marker drawn at every
  page boundary, so you always see where pages will break while editing.
- **Page view · A4** — content laid into true A4 page frames with running header, page numbers and the
  gaps between pages visible, i.e. a faithful preview of the printed PDF.

Production pagination should use a paged-media engine (server-side Chromium print, or a Paged.js-style
preview on screen) so the on-screen page map and the generated PDF agree exactly. The prototype
hand-authors the page split to illustrate the behaviour; production computes it.

---

## 5. How this sits on the governance spine

- **Frozen snapshot on "Mark Final".** When a report version is marked final, its numbers, each section's
  text version, and each chart's source data are frozen together into one content-addressed snapshot, so
  a re-print of that version is byte-reproducible and an independent reviewer is bound to exactly what was
  signed off (the version list — v6, v7, "Mark Final" — already exists in the live UI).
- **Provenance & lineage** carry through: a data-bound figure links back to its Outputs lineage; an edited
  section records who edited it and when; an AI draft records that it was AI-generated.
- **Five UI states** apply to the report surface as they do everywhere (empty ≠ zero ≠ loading ≠ failed ≠
  success): a failed data read never renders as a zeroed report.

---

## 6. Build slices (proposed order)

- **R1 — Print-safe chart pack.** Port the report charts to deterministic SVG from the snapshot + the
  single render-ready signal. Removes the PDF breakage. Flag `report-svg-charts`. *No visual reference
  needed beyond the prototype's chart builders.*
- **R2 — Section model + provenance.** Ordered sections, `contentSource`, versioning, Reset-to-default.
  Backend + data model; no new client editing UI yet. Flag `report-sections`.
- **R3 — Data-bound figure tokens.** Token catalogue + resolver + the locked-chip renderer; wire the
  data-integrity banner to include charts and tokens. Flag `report-tokens`.
- **R4 — In-place section editing + Regenerate.** Rich-text editing scoped to section bodies; generalise
  Report Preparation's AI drafting to every section. Flag `report-edit`.
- **R5 — Paged preview + repeating headers.** View toggle (Continuous / Page view), paged-media CSS for
  header groups and break rules, on-screen page-break markers. Flag `report-paged`.

Each slice ships behind its flag with a rendered acceptance pass, same discipline as the data-entry
adapters.

---

## 7. Decisions proposed (to append to DECISIONS.md once branches settle)

> Numbered NZC-048–051. NZC-047 (M6 portal breadth) is on `main` — it merged in PR #46
> (`74e86033`, from `docs/nzc-046-047-refinements`), along with the M6 section in
> `REDESIGN_ROLLOUT.md` and `GAP_ANALYSIS_PORTAL_BREADTH.md` — so the register is continuous
> through NZC-047; append these once the report branches settle.

- **NZC-048 — Editable report sections.** A report is an ordered list of versioned sections, each with a
  `contentSource` of default / ai / client-edited, full provenance, and always-available Reset-to-default
  and Regenerate. Report Preparation's AI drafting generalises to every section.
- **NZC-049 — Data-bound figure tokens.** Figures embedded in report narrative are resolved from the
  report snapshot as locked tokens, never free text, so the data-integrity guarantee survives arbitrary
  prose editing and figures can never drift.
- **NZC-050 — Deterministic print-safe charts.** Report charts render as static inline SVG from the same
  snapshot as the tables; the PDF step waits on one deterministic render-ready signal; no request-time
  canvas rasterisation. Fixes the recurring PDF breakage.
- **NZC-051 — Paged output discipline + on-screen page breaks.** Repeating table-header groups,
  row-atomic breaks and explicit section-break rules via paged-media CSS; an on-screen Continuous vs
  A4 page-view toggle whose page map matches the generated PDF. Report snapshot frozen and
  content-addressed on "Mark Final".
