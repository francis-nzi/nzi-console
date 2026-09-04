# UX1e-1 — job stage-as-section shell (NZC-024 module shell) · acceptance record

> **REVISED by NZC-057 (DA-track / M8, DA2 / PR #85): CRP is now a FOUR-stage shell.**
> "Factor mapping" is retired as a stage — factor selection is inline at capture; unmatched-factor rows are
> a "Needs attention" exception within Data entry. The `StageSection` / `StageFocusStrip` components and the
> `job-stage-sections` flag are **kept** (no new flag — the contract array + one-way stage migration have no
> clean seam, so DA2 landed atomically like DA5). The shell loses one section: the per-entity source
> register re-homes into **Data entry**; unmatched-factor rows surface in the Data-entry **Needs-attention**
> lens. The **4-stage** shape (verified on staging /jobs/712 in DA2):
> `stage-setup` (done · collapsed) · `stage-data-entry` (active · open) · `stage-review-qa` (todo ·
> collapsed) · `stage-report-publish` (todo · collapsed). `stage-sections.spec.ts` asserts exactly this and
> that `#stage-factor-mapping` has count 0. Migration `0053` remapped existing "Factor mapping" CRP jobs
> (→ Data entry if any enabled row lacks a factor, else Review & QA), logged "stage retired (NZC-057)".
> The sections below record the original 5-stage acceptance (2–3 Sep 2026); the stage count is superseded.

Running record for the `job-stage-sections` adapter (`CrpStageSections.tsx`, gated in
`CrpScopeWorkspace.tsx:428`). Reads alongside `docs/DATA_ENTRY_UX.md`, `docs/ACCEPTANCE_UX1E_STAGE_SECTIONS.md`
and the NZC-024 / NZC-038 / NZC-057 decisions. The shell wraps the UX1 accordion (which stays behind
`data-entry-accordion`) — this record covers the **stage container only**; per-stage content acceptance
lives in each stage's own record (UX1 for Data entry).

## Built

| Increment | Scope | PR |
|---|---|---|
| e1 | Stage-as-section shell: `StageFocusStrip` + five `StageSection`s (Setup / Data entry / Factor mapping / Review & QA / Report & publish), prior collapsed · current open · later as to-do cards; existing panels re-homed into their stage; `job-stage-sections` flag added to `DataEntryAdapter` | #71 / #72 |

## Flag

`job-stage-sections` reads the same `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` dashboard var (build-time inlined —
append + rebuild, per `docs/DEPLOYMENT.md` › "Feature-flag flips"). Live on staging 02 Sep 2026; deployed
dashboard value ends `…,data-entry-accordion,job-stage-sections` (confirmed inlined in the deployed bundle
`1011-*.js`).

## Automated suite

Provisioned the acceptance accounts (`npm run acceptance:provision`, isolated non-production DB) and ran
`npm run test:e2e` against **deployed staging** (`https://nzi-pro-api-prod.onrender.com`) with the full flag
set live, 03 Sep 2026.

- **`stage-sections.spec.ts` ×3 — PASS**, and hardened: the flag/shell check is now a **hard precondition,
  not a conditional skip** — a missing shell fails loudly. (The 2 Sep run silently opted out because the flag
  was not yet live; that must never recur.) Each test discovers the CRP job at the "Data entry" stage
  (`discoverCrpJobAtStage`), fails if there is none, then `assertStageShell` asserts: exactly five
  `section.nz-stage-sec` in order with ids `stage-setup` (done, collapsed) · `stage-data-entry` (active,
  open) · `stage-factor-mapping` / `stage-review-qa` / `stage-report-publish` (todo, collapsed); each
  section heading; `.nz-focus-strip` visible; `.nz-command-hero` absent. The only skip left is the
  suite-wide "no staff account" gate (public smoke run).
  1. *renders the five workflow stages, Data Entry expanded* — shell precondition + `#stage-data-entry`
     holds the accordion; a collapsed later stage (`#stage-factor-mapping`) opens on header click and shows
     its `.nz-panel`.
  2. *the focus strip jumps to and opens the relevant stage* — shell precondition + the "QA decisions" strip
     button opens `#stage-review-qa`.
  3. *the stage layout passes the axe baseline and holds the column* — shell precondition +
     `scanWithBaseline(page, "stage-sections")` (no uncatalogued serious/critical) + no horizontal overflow.
- **`accessibility.spec.ts` job-workspace scan — PASS** — the job page with the stage-section shell active
  passes the axe baseline (no uncatalogued serious/critical).
- **`crp-workspace.spec.ts` M2 + `source-register.spec.ts` S1 §9** — re-pointed for the stage-section layout
  (this PR, `fix/e2e-stage-sections-layout`): the M2 "command centre" text anchor → the flag-stable
  "Workflow stage" control heading; the client-factor / per-entity-register guards now expand the collapsed
  Setup / Factor mapping stage (new `expandJobStage` helper) before asserting the panels render. Regression
  intent (no 503 on the client-factor UNION query / per-entity register) preserved.
- **Full run:** `npx playwright test` → **48 passed / 10 skipped / 0 failed** (2.0m) on deployed staging.
  The 10 skips are the standing "not exercised on this job / adapter re-homed" set — `spend-adapter` ×2,
  `commuting-bulk`, `vehicle-bulk`, `source-register` S1 §9 (the discovered CRP job includes no Company
  Vehicles / Employee Commuting categories, so there is no Add-source control to drive), the standalone
  adapter specs whose panels the accordion now owns, and the portal accordion (no open portal entry window
  on the staging job). None are regressions.

## Rendered pass (automated — Cowork 02 Sep 2026 + Claude Code 03 Sep 2026, deployed staging `/jobs/712`)

Shell active (`nz-command-hero` gone; focus strip + five `nz-stage-sec` sections; Setup done/collapsed,
Data entry active/open, later stages todo/collapsed — the UX1e-1 intent). No horizontal overflow at
390 / 768 / 1280 / 1920; body content capped (~1309px) on wide, not stretched. Min sampled text contrast
4.71 (WCAG AA normal-text threshold 4.5), sampled across focus-strip label/next, stage summary, readiness
pill, status pill, eyebrow, h1, sub, primary button. **Inter throughout** (h1, stage summary, focus strip,
button all resolve to the Inter stack — NZC-003 satisfied; no serif). Canonical green lifecycle chrome.

## Gate status (`docs/ACCEPTANCE_UX1E_STAGE_SECTIONS.md` § e1)

| Gate item | State |
|---|---|
| 1 · Five stage sections in workflow order, status-coloured number badges | ✅ e2e |
| 2 · Data Entry expanded, accordion only (no config/register/release leak) | ✅ e2e |
| 3 · Setup holds the six controlled-input panels, collapsed w/ summary line | ✅ e2e (expand + assert) |
| 4 · Prior = summary, later = to-do, every section toggles from its header (`aria-expanded`) | ✅ e2e |
| 5 · Focus strip replaces the command hero — readiness %, next action, three exception jumps | ✅ e2e |
| 6 · Workflow stage control (advance / back / note / history) still works | ✅ (unchanged; `WorkflowStageControl` renders above the body in both layouts) |
| 7 · Opening a scope row still opens the evidence drawer (calculate → review → history → snapshot) | ✅ covered by `accordion.spec.ts` / CRP lifecycle specs |
| 8 · `stage-sections.spec.ts` green on deployed staging (hard shell precondition, no conditional skip) · typecheck · build · console tests | ✅ 3/3 on staging · typecheck clean |
| No horizontal overflow 390/768/1280/1920 | ✅ automated |
| Contrast (chrome + text) AA | ✅ automated (min 4.71) |
| Inter throughout (NZC-003) | ✅ |
| 9 · Screen-reader narration · reduced-motion (stage expand/collapse, focus-strip jumps, chevron rotate) | ⏳ human-only — Francis |

## Rollback

Additive + flag-gated: with `job-stage-sections` absent, `stageSectionsOn` is false and the workspace
renders the legacy command-hero body unchanged. Roll back by removing the token from the Render dashboard
`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` value + rebuild. No data, route or schema change.

## Follow-ups

- e2 (dedicated Factor Mapping + Review & QA surfaces) and e3 (Report & Publish polish; retire the legacy
  command hero once e1–e3 accepted) — `docs/ACCEPTANCE_UX1E_STAGE_SECTIONS.md`.
- Governance (from the flag saga, tracked in `docs/DEPLOYMENT.md`): blueprint-link the service so
  `render.yaml` becomes authoritative again; shared-Supabase isolation risk vs NZC-001 for the boundary
  review.
