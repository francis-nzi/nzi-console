# NZI Console — Visualization & Graphics Subsystem

**Why this document exists.** Graphics are a major part of NZI's delivery — the charts in a report are the
thing a client actually looks at — and in the live platform the graphics pipeline "easily breaks time and
time again." This note diagnoses *why* it breaks (grounded in the live code) and specifies a single,
reliable visualization subsystem for NZI Console so that a chart is created once, is always current, and
looks identical on screen, in the PDF, and in the client portal.

It is a companion to `ARCHITECTURE.md` (decisions **NZC-026–NZC-029**) and `WORKFLOWS.md` §6.

---

## 1. The problem, precisely (as-is)

The live platform renders the same charts through **three different engines**, threads them to **five
consumers**, and has a **fourth** browser stack just to make PDFs. A half-built manifest/validation layer
that would catch the failures exists but was never wired in.

### 1.1 Three chart-rendering mechanisms

| # | Mechanism | Where | Output |
|---|---|---|---|
| 1 | **matplotlib** (`api/chart_generation.py`: `create_donut_chart`, `create_total_emissions_donut`, `create_activity_donut`, `create_bar_chart`) | server | base64 PNG |
| 2 | **Plotly + Kaleido** (`create_reduction_pathway_chart`, `create_interim_pathway_chart`, `create_intensity_pathway_chart` → `fig.write_image(engine='kaleido')`) | server, **headless Chrome** | base64 PNG |
| 3 | **Captured browser widgets** → `job_widget_pngs` (`job_id`, `widget_id`, `png_data`, `captured_at`, **`captured_by`**) | frontend-rendered, **captured by a human**, stored | base64 PNG |

Two different chart libraries with different fonts, colours and sizing produce the "server" charts; a
third set is whatever the front-end drew, snapshotted to an image. Nothing guarantees they share a visual
system.

### 1.2 A fourth browser stack, provisioned at runtime

PDFs are produced by rendering report HTML through **Playwright/Chromium**
(`services/playwright_browser.py`), and Kaleido needs its **own** Chrome (`services/kaleido_browser.py`).
Both **download/provision a browser at runtime** into ephemeral, variable directories
(`/tmp/nzi-…`, `/var/data/…`, WFM-derived paths), guarded by process-global locks, and are "warmed" on
startup "so the first PDF request after a deployment doesn't pay the 2-3 minute download cost." On
ephemeral disk this is exactly the intermittent failure surface: the download is slow, sometimes fails,
and the resolved browser path can be lost between restarts. Two independent browser toolchains double it.

### 1.3 Five consumers that can silently diverge

`job_widget_pngs` (and/or the generated PNG assets) are read by: the **HTML report**
(`job_report_routes` + templates `interactive_report.html`, `professional_report.html`), the **live
report** (`job_live_report_routes`), the **review snapshot** (`job_review_routes`), the **PDF** (HTML →
Playwright), and the **client portal** (`portal_routes` `/portal/insights/widget-pngs`). Each can show a
different version of "the same" chart.

### 1.4 Charts are *captured snapshots*, not *derived values*

This is the root cause. `job_widget_pngs.captured_by` shows charts are **snapshotted by a user action**,
keyed `(job_id, widget_id)` and stamped `captured_at`. They are not regenerated from data on demand — so
after any data change, the stored image is stale until someone re-captures it.

The platform *knows* this: `api/report_manifest_validation.py` computes **`missing_required_widget`**
(error) and **`stale_widget_png`** when `captured_at < jobs.updated_at` (error). But its own docstring
says it *"does not yet wire validation into PDF generation or report rendering,"* and
`api/report_manifests.py` — a clean, versioned manifest of report sections → required widgets — *"does not
wire any PDF or portal paths over to the new manifest-driven renderer yet."* So the fix was designed and
left on the shelf; today a report, PDF or portal view can be published with **stale or missing charts and
nothing stops it.**

### 1.5 A Redis/RQ PDF queue that may not be provisioned

`services/pdf_generation_queue.py` is labelled *"PHASE 1 IMPLEMENTATION … Copy to /services/ after Redis
setup"* and hard-requires Redis + RQ. Another half-wired dependency that turns "make a PDF" into "hope the
worker and Redis are up."

### 1.6 Net failure modes to design out

1. **Visual drift** — three engines, no shared styling → screen ≠ PDF ≠ portal.
2. **Runtime browser provisioning** — two headless browsers downloaded at runtime on ephemeral disk.
3. **Stale/missing charts published silently** — captured PNGs drift from data; validation exists but is not enforced.
4. **Human-in-the-loop capture** — a chart is only as current as the last person who clicked "capture."
5. **Half-wired good ideas** — manifest + validation + queue all exist but aren't the live path.
6. **No provenance on graphics** — a chart image carries no link to the data/version it was built from.

---

## 2. Principles for the redesign

1. **Charts are derived, never captured.** A chart is a pure function of *(reviewed job data + chart spec
   + brand tokens + spec version)*. There is no "capture" button and no human-refreshed image.
2. **One spec, one engine, every surface.** A single declarative chart spec renders identically on screen,
   in the PDF, and in the portal. Screen and print are the *same component*, not two implementations.
3. **Vector-first (SVG).** Charts are SVG end-to-end: crisp at any size, small, themeable by tokens, and —
   crucially — **renderable without a headless browser**. Rasterise to PNG only where a target format
   truly cannot take SVG.
4. **Brand tokens are the single styling source.** The emerald palette, Inter, and the scope colours are
   defined once and consumed by every chart. No per-engine restyling.
5. **The manifest is load-bearing.** Each report family declares its sections and required charts in a
   versioned manifest; the renderer builds strictly from it; **validation is a hard gate before any
   publish / PDF / portal push.** (Adopt and *wire in* what `report_manifests.py` already sketched.)
6. **Content-addressed, not time-stamped.** If a rendered asset is cached, its key is a **hash of the
   underlying data + spec + version** — so a data change changes the key and forces regeneration.
   Staleness becomes structurally impossible; no `captured_at < updated_at` race.
7. **Graphics carry provenance.** Every chart knows which job data, factor set/version and spec version it
   was built from — so a chart is as evidence-backed as a scope row, and expands in the same evidence
   drawer.
8. **Deterministic rendering, provisioned at build time.** No runtime browser download. If server-side
   rasterisation is ever needed, one renderer is pinned and installed at build/deploy, not fetched into
   `/tmp` on first use.

---

## 3. Target architecture

```
                         ┌──────────────────────────────┐
   reviewed job data ──▶ │  Chart data resolver          │  pure query over canonical
   (scope rows, totals,  │  (per job family)             │  reviewed data — one source
    targets, factors)    └───────────────┬──────────────┘
                                          │  ChartData (typed, provenance-tagged)
                                          ▼
   brand tokens ───────▶ ┌──────────────────────────────┐
   (emerald, Inter,      │  Chart spec + renderer         │  ONE component set → SVG
    scope colours)       │  (@nzi/charts, React → SVG)    │
                         └───────────────┬──────────────┘
                                          │  SVG (+ optional rasterisation)
             ┌────────────────────────────┼────────────────────────────┐
             ▼                            ▼                            ▼
      Console screen               PDF / print                 Client portal
      (interactive SVG)      (same SVG, paginated)        (same SVG, read-only)
                                          ▲
                                          │  built strictly from
                         ┌──────────────────────────────┐
                         │  Report manifest (versioned)   │  sections → required charts;
                         │  + validation = HARD GATE      │  missing/incoherent ⇒ block publish
                         └──────────────────────────────┘
```

### 3.1 `@nzi/charts` — one chart package

A workspace package (sibling to `@nzi/ui`) exposing a **small, fixed catalogue** of chart types the
business actually uses, each as a data-bound React component that renders **SVG**:

- `EmissionsScopeDonut`, `EmissionsByActivity`, `EmissionsSiteDonut`
- `ScopeYearOnYearBar`
- `ReductionPathway`, `InterimPathway`, `IntensityPathway`
- (LCA/PCF family) `LcaStageBar`, `ContributionTree` — see §5

Every component takes a typed `ChartData` + tokens and nothing else. Same component instance renders on
screen and to the PDF. This replaces matplotlib **and** Plotly/Kaleido **and** the captured widgets with
one implementation.

### 3.2 The chart spec & data contract

```ts
type ChartSpec = {
  id: string;                 // stable widget id, e.g. "emissions_scope_donut"
  type: ChartType;            // one of the catalogue
  title: string;
  family: JobFamily;          // crp | lca | pcf | training | consultancy
  specVersion: number;        // bumped when the visual definition changes
};

type ChartData = {
  spec: ChartSpec;
  series: Series[];           // resolved, numeric, unit-aware
  provenance: {               // travels with the chart everywhere
    jobId: string;
    dataHash: string;         // hash of the resolved data
    factorSets: string[];     // e.g. ["DEFRA 2024 v1.2", "DESNZ 2024 v1.0"]
    generatedAt: string;
  };
};
```

The **data resolver** is a pure function over already-reviewed job data (the canonical scope-row/emissions
model from `WORKFLOWS.md` §4). It never reaches into a screen's local state — so the number in the chart
is the same number in the table and the report.

### 3.3 Rendering targets

- **Screen (console + portal):** the SVG component, interactive (hover/expand into the evidence drawer).
- **PDF/print:** the *same* components rendered to static SVG and paginated. Because charts are SVG, PDF
  generation needs **no chart-specific headless browser** — the HTML→PDF step embeds vector charts
  directly. (If a single HTML→PDF renderer is retained, it is pinned and build-time installed; better
  still, generate the PDF from a deterministic SVG/HTML→PDF path with no runtime download.)
- **DOCX / raster fallback:** where a target cannot take SVG, rasterise the *same* SVG to PNG through one
  deterministic converter — not a second charting stack.

### 3.4 Caching: content-addressed

If rendered assets are cached at all, the cache key is `hash(dataHash + specVersion + tokensVersion +
target)`. A change to the data, the spec, or the brand tokens yields a new key and a fresh render. There
is no `captured_at` and no human capture step; "stale chart" cannot occur by construction. The old
`job_widget_pngs` table is retired (or becomes a pure content-addressed cache, never a source of truth).

### 3.5 Manifest-driven assembly + hard validation gate

Adopt `report_manifests.py`'s shape (sections → `required_widgets` / `optional_widgets` / `layout`,
versioned per report family) and make it the **only** way a report is assembled. Before a report can be
**published, turned into a PDF, or pushed to the portal**, validation runs and **blocks** on:

- a required chart whose data cannot be resolved;
- a chart whose provenance doesn't match the current reviewed data;
- any chart that fails to render.

This is the single change that ends "published with missing/stale graphics": the same validator that
already exists, wired in as a gate instead of a standalone helper.

---

## 4. One asset, three surfaces — and the evidence drawer

Because a chart is derived and provenance-tagged, the *same* chart object serves the console screen, the
PDF and the portal, and it participates in the console's signature evidence model: clicking a chart opens
the evidence drawer showing its series values, the factor sets/versions behind them, the data hash, and a
link back to the contributing scope rows. A chart is no longer an opaque image — it is a view over
evidence, exactly like a scope row.

---

## 5. Interaction with job-family separation (see ARCHITECTURE §6)

Separating CRP / Consultancy / LCA / PCF / Training into distinct modules does **not** mean separate
graphics stacks — that is precisely the trap the live system fell into. Instead:

- **Shared:** the `@nzi/charts` engine, the brand tokens, the SVG-first rendering, the content-addressed
  cache, the manifest mechanism and its validation gate.
- **Per family:** its **own report manifest(s)** and its **own chart catalogue subset**. CRP uses scope
  donuts and reduction pathways; LCA/PCF uses life-cycle-stage and contribution charts; Training uses
  attendance/completion visuals. Each family declares what it needs; all families render through one
  subsystem.

So the modules are separate where the *content and workflow* differ, and unified where the *rendering
technology* must not.

---

## 6. Migration path

1. **Stand up `@nzi/charts`** with the CRP catalogue as SVG components, driven by the mock data already in
   `@nzi/mock-data` (which already carries scope rows, quality tiers and factor sets). Prove screen +
   print parity on mock data — no backend.
2. **Adopt the manifest** (`report_manifests`) as the assembly contract for the CRP "professional" report;
   render the whole report from it on mock data.
3. **Wire validation as a gate** in the console's publish/PDF/portal flows (still mock) so the failure mode
   is designed out before any wiring.
4. **When wired-but-isolated:** point the data resolver at the isolated backend's reviewed data; keep the
   same components. Retire `job_widget_pngs` as a source of truth (optionally keep as a content-addressed
   cache).
5. **Eliminate runtime browser provisioning:** ship the single pinned renderer at build/deploy; delete the
   Kaleido path entirely (no more Plotly server rasterisation); keep at most one deterministic HTML/SVG→PDF
   step.
6. **Per-family catalogues** (LCA/PCF, Training) added as those modules land — each a manifest + a chart
   subset, never a new engine.

---

## 7. What this fixes (traceable to §1.6)

| As-is failure | Redesign that removes it |
|---|---|
| Visual drift across engines | One engine, one spec, shared tokens (§2.2, §3.1) |
| Runtime browser provisioning | SVG-first; no headless browser for charts; pinned build-time renderer (§2.3, §3.3) |
| Stale/missing charts published | Derived charts + content-addressed cache + manifest validation **gate** (§2.1, §3.4, §3.5) |
| Human capture step | Charts regenerate from data automatically (§2.1) |
| Half-wired manifest/validation/queue | Manifest becomes the only assembly path; validation is enforced (§3.5) |
| No provenance on graphics | Provenance travels with every chart; expands in the evidence drawer (§2.7, §4) |
