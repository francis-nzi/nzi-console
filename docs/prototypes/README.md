# NZI Console prototypes — build reference for Claude Code

Read each alongside its spec. Prototypes are the visual reference; the spec doc governs where a
detail is not visible in the HTML.

| File | Surface | Spec | Published Artifact |
|------|---------|------|--------------------|
| `crp_v3.html` | CRP Workspace (consultant data entry) | `docs/DATA_ENTRY_UX.md` (NZC-046) | https://claude.ai/code/artifact/f5fda985-b9eb-428c-ae8a-1c59d062cc43 |
| `portal_v3.html` | Client Portal (data entry) | `docs/DATA_ENTRY_UX.md` (NZC-046) | https://claude.ai/code/artifact/513f921c-c169-4b9c-89a4-34899892e789 |
| `report_v3.html` | Report → Report Printing | `docs/REPORT_PRINTING_UX.md` (NZC-048–051) | https://claude.ai/code/artifact/d3dd74a6-5031-471a-bde6-5cfa0cefdf6f |
| `client_workspace_v9.html` | Client Workspace (overview, carbon analytics, sites, contacts, identity, record areas) — supersedes v8 | `docs/CLIENT_WORKSPACE_BACKLOG.md` (NZC-005, NZC-070, NZC-071), `docs/PERMISSION_MATRIX.md` (NZC-022) | — |

## client_workspace_v9 — what is built against it
v9 supersedes v8 and adds the go-live hardening surfaces: contact roles (signee / portal / billing /
training) on the contact drawer and contacts list, client logo upload in the identity drawer, and the
financial-year-end month.

Built (from v8, unchanged in v9): the **◈ Evidence** chip on Latest emissions (metrics strip), Scope split and Intensity
detail (+ Year on year); the provenance drawer (figure + tier, context line, signature, lineage,
governance note, *Open source snapshot →*); the Scope split donut with per-scope tiers; the **Sites**
list (Registered / Vacated / Planned tags, in-service line, floor area, per-row boundary statement)
and the site drawer (registered office, in-service date + In service / Vacated, vacated effective
date, floor area, governance note).

Built (new in v9 — go-live hardening): the **Contacts** card with *Primary* and role badges (Signee /
Portal / Billing / Training) and the contact drawer (full name, job title, email, phone, the five role
checkboxes, *Remove* = deactivate, *Save contact*); the header **logo badge** (✎) opening the **Identity &
profile** drawer — logo upload / remove with the monogram fallback, name, status, industry, SIC,
reporting frequency, currency and the **Financial year end** month select with v9's hint; and the
*Identity & profile* card. Report signees, portal candidates and the logo also reach the release
control, the portal invite picker, the portal header and the published report.

Deliberate differences: the evidence drawer uses the app shell's drawer slot rather than an overlay;
dates are dd/mm/yyyy (NZC-040) not "Apr 2019"; a site can be *in service from before records*
(NZC-070 NULL start); floor area is an effective-dated history (NZC-071), not one value.

Not built yet (outside the provenance + sites brief): the area sub-nav and its areas (Reporting,
Actions, SRS Readiness, Tasks, Notes, Files, Communications, Company Profile, Financials, AI
Profile); client setup progress; the Emissions history, YoY-by-scope, multi-base intensity and
reduction-pathway charts with the reporting-year picker; Baseline & targets (needs
`client_baselines`, #137); site reference / address / geolocation; Financial status
and outstanding balance (commercial ledger, NZC-069 Open, #140); "vs baseline" figures.

## report_v3 — the four fixes it demonstrates
- Print-safe charts (deterministic inline SVG, canonical @nzi/charts palette: S1 coral / S2 amber / S3 emerald).
- Editable sections (Edit / Regenerate AI / Reset; default / AI-drafted / client-edited status).
- Data-bound figure tokens (locked green chips; editing prose can't drift the numbers).
- Paged output: Continuous ↔ Page view (A4), page-break markers, repeating table headers.
- All text is Inter (NZC-003); all dates dd/mm/yyyy (NZC-040); "carbon emissions" not "footprint" (NZC-039).
