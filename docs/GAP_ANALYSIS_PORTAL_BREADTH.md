# NZI Console — Client Portal Breadth Gap Analysis (Part 2)

**Part 2 of the redesign gap-analysis series** (Part 1 = data entry). Catalogues the **11 areas of the live
client portal** against the redesigned Console portal, so the plan for bringing them across is on record
before **M6 · Client portal breadth** starts. Grounded in the live `nzi_pro` portal
(`portal/src/components/PortalShell.tsx` + area components) as of 1 Sep 2026.

**Status legend.** **[DONE]** already in the redesign · **[PORT]** mature; re-platform onto the new spine
(mostly presentation) · **[MODEL]** mature logic but needs a new domain model in `@nzi/contracts` +
isolated-backend · **[FOLD]** still being developed in live; fold in as it stabilises.

## 1. The 11 live portal areas vs the Console

| # | Live area | What it is | Data source | R/W | Maturity | Status | Depends on |
|---|-----------|-----------|-------------|-----|----------|--------|-----------|
| 1 | Dashboard | Composite overview | (assembled) | R | developing | **[FOLD]** | Metrics + Insights |
| 2 | Portfolio | Multi-site / multi-year rollup | `/portal/portfolio-dashboard` | R | developing | **[FOLD]** | snapshot + charts |
| 3 | Data Entry | Activity capture | canonical rows | R/W | — | **[DONE]** | NZC-046 |
| 4 | Metrics | The numbers / data views | `/portal/metrics`, `/portal/reporting-data` | R | mature | **[PORT]** | reviewed snapshot |
| 5 | Strategy (Actions) | Actions + action-lever framework | `/portal/actions` (+ categories, contacts, from-library, lever-summary) | **R/W** | mature | **[MODEL]** | new Actions domain |
| 6 | Risk | Risk view | (derived) | R | developing | **[FOLD]** | snapshot |
| 7 | Governance | Access / governance view | (portal governance) | R | developing | **[FOLD]** | extends M1 portal governance |
| 8 | SRS Readiness | Standards-readiness assessment | `/portal/srs-readiness` | **R/W** | mature | **[MODEL]** | new Readiness domain |
| 9 | Reports | Published report + approval | reviewed snapshot | R/W | — | **[DONE]** | M1 |
| 10 | Insights | Charts & graphs | `/portal/insights/widget-pngs` | R | mature | **[PORT]** | `@nzi/charts` (SVG, not PNG) |
| 11 | Files | Document library + upload | `/portal/files` | R/W | developing | **[FOLD]** | upload + AV (NZC-046) |

The redesigned portal today has four areas (Results, Data entry, Documents, Messages). Bringing in the rest
means the portal **regains its full left-nav** for *areas*, while **stage-as-section** stays for *workflow
surfaces* (data entry, report approval).

## 2. Principles for incorporation (apply to every area)

- **One evidence spine.** Every read surface derives from the **reviewed, immutable snapshot** — the client
  never sees a figure that can silently change. Derived, never captured.
- **Derived charts, not PNGs.** Insights/Metrics/Portfolio/Dashboard render through **`@nzi/charts`** (SVG,
  provenance-bearing, identical on screen/PDF/portal) — replacing live's `widget-pngs`
  (GRAPHICS_PIPELINE; NZC-026–029).
- **One design language.** Left-nav for areas; stage-as-section within workflows (NZC-038); constrained
  mirror of the CRP (NZC-016/035).
- **Behind flags, staged.** Each area flips on its own, on the same strangler pattern as the data-entry
  slices.

## 3. The three shapes of work

- **[PORT] — Metrics, Insights, Portfolio, Dashboard.** Read surfaces on the snapshot + `@nzi/charts`.
  Mostly presentation; the only real change is Insights moving off captured PNGs to derived SVG. Lowest
  risk; because they only read, they can run **in parallel** with later data-entry slices.
- **[MODEL] — Strategy (Actions), SRS Readiness.** Mature in live, but each needs its **own domain model**
  brought into the Console (contracts + isolated-backend migrations), like the data-entry model work:
  - *Actions:* action with status (Proposed/Approved/In Progress/Completed), owner, scope, term, category;
    the action library ("from library"), the **action-lever framework**, contacts, and a lever summary.
    Governed (audit, versioning). Effectively a job-family-scale domain — the largest breadth item.
  - *SRS Readiness:* a readiness assessment model (items, responses, evidence) against the standard.
- **[FOLD] — Risk, Governance, Files.** Governance extends the **M1 portal access/governance** already
  built; Files sits on the **document library + virus-scanned upload** (NZC-046); Risk is a smaller derived
  surface. Fold each in as it stabilises in live.

## 4. Sequencing (M6)

1. **Metrics + Insights** (PORT) — first; snapshot + charts spine already exists.
2. **Portfolio + Dashboard** (PORT/FOLD) — composite views once Metrics/Insights are in.
3. **Strategy / Actions** (MODEL) — its own milestone; model first, then UI.
4. **SRS Readiness** (MODEL) — model + guided assessment UI.
5. **Risk · Governance · Files** (FOLD) — fold in as they stabilise; Files with the upload/AV capability.

**Entry:** the data-entry framework (S-slices) is down and the reviewed-snapshot + `@nzi/charts` spine is
proven. **Exit per area:** its own acceptance gate + flag flip; reviewed-snapshot-backed; accessible.

## 5. Decisions

- **NZC-047 (confirmed 1 Sep 2026):** the live portal's 11 areas are incorporated as **M6 · Client portal
  breadth** on the shared evidence spine and `@nzi/charts` (derived, not PNG), one design language
  (area nav + stage-as-section workflows), reviewed-snapshot-backed, phased and flag-gated. Mature areas
  (Metrics, Insights) re-platform; **Strategy/Actions and SRS Readiness each need a new domain model**
  before their UI.
- **Open:** confirm the Actions/action-lever data model and the SRS readiness model with Francis before
  their slices (they are schema-shaping, like the data-entry model was).

*Prepared 1 Sep 2026. Part 2 of the gap-analysis series; companion to GAP_ANALYSIS_DATA_ENTRY.md (Part 1),
DATA_ENTRY_UX.md, and REDESIGN_ROLLOUT.md (M6).*
