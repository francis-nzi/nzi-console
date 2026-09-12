# NZI Console — design conventions (locked)

The standing UI conventions for the redesign. These are **load-bearing**: build every new
screen to them, and don't diverge without a decision. Cross-references: `DECISIONS.md`
(NZC-###), `PERMISSION_MATRIX.md` (NZC-022), `ARCHITECTURE.md`.

## 1. Foundations

- **Type:** Inter throughout.
- **Palette:** Emerald `#0BA75E`, Deep Pine `#0B7A4B`, Midnight `#0B1B2B`, Signal Amber
  `#FFC24B`, Drop Coral `#FF5C48`, Mint Tint `#DFF5E9`.
- **Scope identity is brand-locked and categorical:** Scope 1 coral, Scope 2 amber,
  Scope 3 emerald — fixed order, never recoloured by rank. Amber text is illegible, so
  Scope 2 *text* uses a darker ink token (`--s2-ink`), never the fill colour.
- **`--danger` is a separate semantic token** from the scope palette. Never reuse Drop
  Coral (Scope 1) to mean "error/destructive"; destructive actions use `--danger`.

## 2. Theme-aware, three-state

Define the full light palette on bare `:root`. Redefine tokens for dark only, guarded:
`@media (prefers-color-scheme: dark){ :root:not([data-theme="light"]){…} }` and again under
`:root[data-theme="dark"]{…}` so an explicit toggle wins both ways. Never give a colour its
only definition inside a media/`[data-theme]` block; always paint `body` an explicit token
background.

## 3. Shell & navigation

- Shell: left global **WorkspaceRail** · top **TopBar** (command/search + breadcrumbs) ·
  main · right **drawer slot** (EvidenceDrawer + edit drawers render here, never inline).
- The **client workspace** has its own left **area sub-nav** (Overview, Carbon Analytics,
  Reporting, Actions, SRS Readiness / Tasks, Notes, Files, Communications / Company
  Profile, Financials, AI Profile), between the global rail and the content. Areas are
  navigated by the sub-nav, not the breadcrumb.

### 3.1 Breadcrumbs (locked)

Breadcrumbs carry the **full hierarchy including client context**, and **every crumb is a
link** — no crumb is ever plain text.

Structure (matches the live system):

| Page | Breadcrumb |
|---|---|
| Client workspace | `Clients / <Client name>` |
| Job workspace | `Clients / <Client name> / Jobs / <Job No>` |
| Job sub-area (Scope rows, Spend Data, …) | `Clients / <Client name> / Jobs / <Job No> / <Area>` |

Link targets — each resolves to a real route:

- **Clients** → `/clients`
- **&lt;Client name&gt;** → `/clients/{clientId}`
- **Jobs** → the client's jobs list (`/clients/{clientId}/jobs`, or the client-scoped jobs route)
- **&lt;Job No&gt;** → `/jobs/{jobId}` (label is the clean job number, e.g. `J000712`)
- **&lt;Area&gt;** → `/jobs/{jobId}/{area}` — the current page; still a real link, styled as
  current with `aria-current="page"`.

Rules:

- Produce breadcrumbs from **one shared builder/component** fed by canonical client/job
  data; the client is resolved from the job's `clientId` and **never omitted** on job pages.
- No ad-hoc per-page crumb markup; no `<b>`/`<span>` stand-ins for links.
- `<nav aria-label="Breadcrumb">`; separators are decorative; the last crumb carries
  `aria-current="page"`.

### 3.2 Collapsible cards (locked)

Client Overview cards are collapsible, and **only "Active jobs & milestone progress" is
expanded by default** — Activity, Emissions history, Baseline & targets, and any future
Overview card are collapsed by default. The chevron toggles the card; state is per-viewer
convenience (may use `localStorage`), never load-bearing.

## 4. Editing model

- **Drawer-based editing everywhere.** Records are edited in drawers opened from the page,
  not on a separate `/edit` page. There is **one editor per thing** — do not keep both a
  drawer and an edit-form field for the same data.
- **One shared field model** backs create and edit (same field groups, same validation).
- **`GatedButton`** for persistent gates: `aria-disabled` (not native `disabled`) plus a
  visible reason, so the control stays focusable and the reason is announced.
- **`InfoTip`** for help-on-demand next to a field/figure, rather than inline help clutter.
- `Drawer` and `Tabs` are shared `@nzi/ui` primitives; reuse them, don't re-implement.

## 5. Evidence & truth

- **Evidence-drawer-first:** no figure appears without its lineage one click away. Every
  emissions figure carries a `◈ Evidence` affordance opening the EvidenceDrawer with the
  provenance signature (factor set + version + data hash + as-at date), the data-quality
  tier, and the calculation lineage. Figures are **derived from the assured snapshot, never
  captured** (NZC-066 issue-time stamping).
- **Distinct data states** — empty / loading / degraded / failed / success are visibly
  different. **Never render a failed query as zero.** A figure that can't be resolved reads
  **"unavailable"**; a client with no prior year reads **"No earlier reviewed year"**, never
  a fabricated vs-baseline %.
- **Resolve, don't seed.** Screens show resolved per-client/per-job data or an honest empty
  state — never seeded placeholder figures. Two different clients must render different data.

## 6. Governance in the UI

- Every mutation is a **permission-checked command that emits an audit event**; UI gating is
  convenience only, the server check is authoritative. Capabilities come from
  `PERMISSION_MATRIX.md` (NZC-022) — never invent a capability string in a component.
- **Deactivate, never delete** (contacts, sites, factors, …). No hard-delete controls.
- **Effective-dating** for boundary-affecting records (e.g. sites): records carry
  in-service / vacated dates; the reporting boundary is resolved per reporting year, and
  historical years keep a since-vacated record.
- **Governed changes** (re-baseline, target restatement) require a reason and are audited;
  targets are held by default on re-baseline (NZC-068).

## 7. Formatting

- **Dates `dd/mm/yyyy`** (NZC-040), everywhere, including inside drawers and timelines.
- Numbers tabular; emissions in `tCO₂e` (or `kgCO₂e/m²` where per-area); percentages signed
  where they express change (`−7.4%`).

## 8. Charts

- All charts render through `@nzi/charts` (one SVG spec → screen, PDF, portal); derived from
  data, never captured. Follow the `dataviz` method: one axis (never dual-axis — index to a
  common base instead), categorical hues assigned in fixed order, run the palette validator
  before adding categorical colours. Scope colours use the brand-locked identity above.

## 9. Intensity metrics (locked)

- Intensity metrics are **defined on the client** and their **annual values are recorded on
  the job** (per reporting year). **Employees** and **Turnover** are standard for every
  client (fixed icons; unit/divider editable; deactivate-not-delete, never removable); any
  number of **additionals** can be added per client.
- Each metric carries: label, unit wording, a **Per-N divider** (1 / 10 / 100 / 1,000 /
  10,000 / 100,000 / 1,000,000), and a **print-safe icon** from the curated NZI icon set
  (auto-suggested from the label, overridable). The icon and divider are part of the
  versioned definition.
- One resolver computes intensity (`emissions × divider ÷ value`) for **every surface** —
  the client YoY, the intensity detail, the client portal and the report — so they cannot
  diverge. A metric with no recorded value for a year reads **"unavailable"**, never 0.
- The metric's icon renders **identically** across the client YoY, the portal and the
  report (print determinism, same rule as charts).
