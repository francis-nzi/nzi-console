# Handoff brief — Client workspace shell rebuild

Rebuild the client page to the v10 information architecture so the already-built features
render inside the approved design, not grafted onto the old page. **Design reference
(authoritative for layout): `docs/prototypes/client_workspace_v10.html`.** Branch + PR;
typecheck AND build green before every push.

**Why:** every prior brief added a *feature* onto the existing `page.tsx`. The page
shell/IA was never rebuilt, so the deployed client page is the old two-tab layout with the
new capabilities grafted on. A prototype-vs-Render comparison confirms it: the target
model, evidence chip, effective-dated sites, floor area, year-end and resolve-don't-seed
are all live and correct — only the shell is old. This brief commissions the shell. It is
**composition over existing read models and commands** — do NOT reimplement or regress any
merged backend.

**Dependency:** #142 (hardening) and #145 (targets) are merged. Build on top of `main`.

---

## PRESERVE — do not regress, and do not flatten to the static prototype

The prototype is the **layout** reference, not a data reference. Where the shipped
implementation is more correct or more honest than the static prototype, **the
implementation wins** — carry these forward into the rebuilt shell:

1. **The "FY24 vs target line" computed gap** on the Baseline & targets card
   (e.g. "1,418 vs 1,698 tCO₂e · 16.5% below"). The prototype doesn't show it; keep it.
2. **The honest "No earlier reviewed year" state** (and every other truthful empty/
   unavailable state). Never replace it with a fabricated vs-baseline % just because the
   prototype shows one for a client that happens to have prior years.
3. **All merged backend behaviour** — provenance resolution, site effective-dating, floor
   area, per-client resolution (two clients render different data), permission gating.
   Verify each still works after the rebuild.

If the prototype and the shipped behaviour disagree on a **number or a state**, the shipped
behaviour is right. If they disagree on **layout/IA**, the prototype is right.

---

## PHASE 1 — the shell + the two real areas (this is what makes Render match v10)

🟡 **1. Client area sub-nav + shell.** Introduce a client-level left sub-nav (a new
`@nzi/ui` component, e.g. `ClientWorkspaceNav`) between the global WorkspaceRail and the
content, with the v10 areas grouped: **CLIENT** (Overview, Carbon Analytics, Reporting,
Actions, SRS Readiness) · **MANAGE** (Tasks, Notes, Files, Communications) · **RECORD**
(Company Profile, Financials, AI Profile). It drives the active area; the global rail
stays. The EvidenceDrawer and all edit drawers render in the shell's right-hand drawer
slot, not inline.

🟢 **2. Overview area, rebuilt to v10:**
- Metrics strip: Open jobs, Latest emissions + ◈ Evidence, Data completeness, **Sites in
  service** (keep Sites-in-service as the 4th metric — Outstanding balance belongs with the
  held commercial work). Keep the resolved values already live, incl. the honest
  "No earlier reviewed year" state.
- Client setup progress strip.
- "Active jobs & milestone progress" pinned at the top of the stack (not collapsible).
- "Emissions history" and "Baseline & targets" as collapsible cards, collapsed by default.
  Baseline & targets keeps the targets block **and the FY-vs-target-line gap** (see
  PRESERVE); baseline-in-force shows as a single line until #137 completes the baseline
  half (dated record + history timeline).
- Right column: Contacts (role badges + Add), Sites (geo/floor badges + Add,
  effective-dated), Financial status (collapsed). All editing via drawers.

🟢 **3. Carbon Analytics area:** reuse `@nzi/charts` for YoY emissions by scope, the
scope-split donut with the reporting-year picker, multi-base intensity (revenue / FTE / m²
+ All indexed), and the reduction pathway DERIVED from the target model (#145). Evidence
affordance on the figures, opening the EvidenceDrawer.

🟡 **4. Drawer-based editing everywhere; retire the separate edit page.** All record editing
moves to drawers: Identity (logo + year-end), Targets, Re-baseline, Contact (roles), Site
(registered office, effective-dating, floor area, geocode), Address, Client factors, Portal
access. Remove `ClientEditTabs` / the `/edit` route and the top-right "Edit client" button
that opens it — one editor per thing, the drawer. Every mutation stays permission-gated per
`docs/PERMISSION_MATRIX.md` and audited.

**Guardrails:** reuse `@nzi/ui` primitives (AppShell, TopBar, Drawer, EvidenceDrawer, Tabs)
and the design tokens; no seeded/hard-coded figures reintroduced; distinct empty/loading/
degraded/failed states on every area and figure; verify no merged feature regresses.

---

## PHASE 2 — the remaining areas (separate PR, on top of Phase 1)

🟢 **5.** Build the other areas as their v10 screens, wiring each to its backend where one
exists and showing a truthful "not yet available" state where it doesn't — never fake data:
- **Reporting:** report list with per-report open + version + PDF.
- **Company Profile:** identity / compliance / addresses / client-factors, drawer-edited.
- **Actions:** the A2-lite qualitative tracker (until the action-lever library lands).
- **SRS Readiness:** the readiness summary.
- **Tasks / Notes / Communications:** client-scoped, wired to their backends when present,
  else an honest empty state.
- **Files:** client files list.
- **AI Profile:** grounded advisory context, clearly separated from the evidence base.
- **Financials:** HELD — show a truthful "Commercial ledger arrives with the quotes/invoices
  work (NZC-069, on its own branch)" state, NOT the mock ledger.

---

## ACCEPTANCE (real data; build+typecheck green; on a PR)

- The client page renders the v10 left area sub-nav; Overview and Carbon Analytics match
  the prototype and carry the live provenance, sites, targets and analytics.
- All record editing is via drawers; the separate `/edit` page and "Edit client" button are
  gone; one editor per field.
- Every merged feature still works (provenance, effective-dating, floor area, targets,
  resolve-don't-seed); no seeded figures anywhere.
- **The FY-vs-target-line gap and the "No earlier reviewed year" honest state are still
  present** (not flattened to the prototype).
- Areas without a backend show a truthful unavailable state; Financials shows the held
  state, not mock data.
- Two different clients render different content; permission gating holds.
