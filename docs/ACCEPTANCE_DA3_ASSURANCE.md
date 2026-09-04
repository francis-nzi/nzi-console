# DA3 — Data Assurance stage (Review & QA → assurance surface) · acceptance

Track: **M8 · Data Assurance**. Decisions **NZC-059 / NZC-060**. Prototype: `docs/prototypes/review_qa_v1.html`.
Flag: **`data-assurance`** in `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`. Consumes the DA1 backend
(`GET /api/isolated/jobs/[jobId]/assurance`).

Sliced so the governance-critical piece lands last:

| Slice | Scope | Status |
|---|---|---|
| **DA3a** | Read surface — five-year trend (BL pill always shown, "% vs BL" its own column with the NZC-060 neutral tone), By scope / By site / Audit / Intensity tabs, CSV export. Read-only. | 🟢 built (PR #86) |
| **DA3b** | Right overlay drawer (table keeps full width; reopen tab) — gaps list, resolve-with-reason via `assurance.gap.resolve` (optimistic + `expectedVersion`), "fix the row" round-tripping `computeAssuranceGaps`; drawer doubles as the shared row-detail drawer | 🟢 built (PR #87) |
| **DA3c** | Row approvals in-stage + **governed sign-off** — the gate (blocked while any gap open **or** any enabled row unapproved) → `report.snapshot.create` freezing the snapshot (+ the frozen `gapResolutions`), reviewer + timestamp. | 🟢 built (PR #88) |

## DA3b — the gap drawer + resolve/fix

`CrpAssuranceDrawer` (rendered by `CrpAssuranceStage`) is a `position:fixed` **overlay** — a separate
mechanism from the app's docking `EvidenceDrawer` (`.nz-app` reserves a grid column for that one; the
assurance drawer must not shrink the trend table, per NZC-059). It is open by default; a "🛡 Data assurance ·
N" tab reopens it when closed.

- **Gaps segment (default).** Every gap from the DA1 engine, coloured by flag. **"Resolve…"** reveals a
  reason textarea; **Save** calls `assurance.gap.resolve` with `expectedVersion` = the gap's current
  resolution version (`0` for a first resolve, matching the `report.section.edit` optimistic-lock
  convention) — a concurrent resolve on the same gap is a `VersionConflictError`, surfaced as a banner.
  A resolved gap stays visible with its reason (`✓ Resolved — …`) and can be re-opened for editing.
  **"Go to row"** (row-scoped gaps only) switches the drawer to the row-detail segment for that row.
- **Row detail segment.** Selecting an audit-table row (or "Go to row" on a gap) shows that row's evidence
  — category, factor, quantity, quality tier, confidence, site, review state — read-only, **plus an "Edit
  in Data entry →"** action that jumps to the Data-entry stage and opens the row in the existing scope-row
  editor (`EvidenceDrawer`) — that's where a gap is actually **fixed**. Fixing the row and reloading
  `/assurance` re-runs `computeAssuranceGaps` from the current data, so a fixed gap clears on its own —
  there is no separate "mark fixed" action.
- **Migration `0054`** adds `version` to `gap_resolutions` (additive) so `assurance.gap.resolve` can carry
  `expectedVersion`; `GapResolution` / `AssuranceGap.resolution` now include it. Applied to isolated staging
  before merge — required because `listGapResolutions` (already read by `report.snapshot.create`, an
  always-on command) now selects the new column.

## DA3c — row approval in-stage + governed sign-off

**Integration outline (confirmed by Francis, 4 Sep 2026)** — the gate composes two signals this surface
already reads, no new computation:

- **All gaps resolved** — `gaps.openCount === 0`, from the existing `GET /assurance` payload.
- **All enabled rows approved** — `pendingReview === 0`, derived client-side from `auditRows` (already
  enabled-only) where `reviewStatus !== "approved"`.

**Row approval** (`RowReview`, inside the drawer's row-detail segment) calls the *existing*
`scope.review.approve` / `scope.review.reject` commands — the same `POST
/scope-rows/{rowId}/review` endpoint the legacy Data-entry row panel uses — unforked. `AssuranceAuditRow`
gained `version` (→ `expectedReviewVersion`) and `reviewerNote` to support this in place, reading directly
off the already-selected `job_scope_rows` columns (no new column, no migration).

**Governed sign-off** (`SignOffPanel`) reuses `report.snapshot.create` / the existing `POST
/reviewed-snapshots` endpoint unforked — same button the legacy panel already exposed, moved here. The
**new** server-side work is one gap-check inside `createReviewedCrpSnapshot`, in the same transaction and
row-lock as the existing `QA_INCOMPLETE` check: it now also calls `getAssuranceScreen` and throws a
`GAPS_OPEN` validation error if `openCount > 0`. "All rows approved" was **already enforced** there
(`QA_INCOMPLETE`) before DA3c — nothing new needed for that half. `gapResolutions`, reviewer and timestamp
were already folded into the frozen payload (DA1e) / the snapshot's own `created_by`/`created_at`.

The client-side gate (`canSignOff`) only disables the button and explains the blocker — the server is the
actual authority; a stale client view still gets a `GAPS_OPEN`/`QA_INCOMPLETE` rejection, not a bad freeze.

## DA3a — the read surface

`CrpAssuranceStage` renders in the **Review & QA** `StageSection` when `data-assurance` is on.

- **Header** — Total + Scope 1/2/3 for the current year; baseline year + **BL pill** (or a prompt to set a
  reduction target when there is no baseline); reporting year.
- **Integrity banner** — `N gaps to resolve` ↔ `Data integrity check passed`, with per-flag chip counts.
- **Five-year trend** (`table.nz-assurance-trend`) — Scope · Category · one column per chain year
  (`[baseline BL]`, priors, `[current]`, baseline + current tinted) · **`% vs BL`** = current ÷ baseline − 1,
  toned via `percentVsBaselineTone` (**neutral grey** when a reduction is driven by an unresolved
  completeness / zero-blank / unmapped flag) · **Integrity** column with the gap chips. Per-scope subtotals
  (from `AssuranceTrendYear.byScope`) + `All scopes total`. Flagged category rows get a coloured left edge.
- **Tabs** — By scope (category amalgamation, baseline vs current); By site (current year, **Unallocated**
  rows flagged as a completeness signal); Audit table (per enabled row: category, factor, qty+unit, quality,
  confidence, site, review — unmapped rows flagged); Intensity (`total ÷ reporting denominator` across the
  trend, or a "no intensity target" note).
- **CSV export** of the trend.
- **Five explicit UI states** — loading · **failed** (an `alert` + Retry, *never* a table of zeros) ·
  degraded · success. A 503 from `/assurance` renders the failed state, not a zeroed report.

## Gate (DA3a)

| # | Item | Check |
|---|---|---|
| 1 | Trend renders **baseline column with BL pill (always present)** + priors + current; **`% vs BL`** is its own column, computed vs baseline (not prior year) | `data-assurance.spec.ts` |
| 2 | `% vs BL` tone is neutral grey when driven by an unresolved non-YoY flag; normal otherwise | `packages/contracts/tests/dataAssurance.test.ts` (`percentVsBaselineTone`) |
| 3 | `getAssuranceScreen` composes trend + gap engine (4 flags) + audit rows; non-CRP → null | `packages/isolated-backend/tests/assuranceScreen.test.ts` |
| 4 | Tabs switch views; By site flags **Unallocated**; Audit flags unmapped rows | e2e |
| 5 | A failed `/assurance` read → `alert` + Retry, **no `table.nz-assurance-trend`** | e2e |
| 6 | No uncatalogued serious/critical axe violations; no horizontal **page** overflow at 390 / 768 / 1280 / 1920 (the wide table scrolls inside its own panel) | `scanWithBaseline(page, "data-assurance")` + `expectNoHorizontalOverflow` |
| 7 | **Flag hard-precondition** — once the surface is present, every check is hard (fail loud, no silent skip). The one conditional skip (flag not yet live) is removed in the flip PR. | `data-assurance.spec.ts` `openAssurance` |
| 8 | Drawer **overlays** — the trend table's rendered width is identical drawer-open vs drawer-closed; reopen tab works | e2e |
| 9 | Resolve-with-reason persists (survives reload); a stale `expectedVersion` is a version conflict | e2e + `resolveAssuranceGap` unit (`VersionConflictError`) |
| 10 | Selecting an audit row shows its evidence in the drawer's row-detail segment | e2e |
| 11 | `npm run typecheck` · `@nzi/console` build · full unit suites green · **flag OFF leaves Review & QA unchanged** | ✅ |
| 12 | **Human-only:** screen-reader on the tabs + trend table + banner + drawer; keyboard reaches Resolve/Save/Cancel and the audit rows; reduced-motion; the BL / current tint reads as AA | ⏳ Francis |

## Gate (DA3c)

| # | Item | Check |
|---|---|---|
| 1 | Sign-off blocked while `openCount > 0` **or** any enabled row is unapproved — `GAPS_OPEN` / `QA_INCOMPLETE`, same transaction, unforked from `report.snapshot.create` | `packages/isolated-backend/tests/snapshotGapsGate.test.ts` |
| 2 | Row approval reuses `scope.review.approve`/`reject` unforked — no new command, no new column | code review (`RowReview` → existing `/scope-rows/{id}/review`) |
| 3 | The sign-off panel always renders; its button is disabled with a stated blocker reason while gated | `data-assurance.spec.ts` |
| 4 | A pending row can be approved in-stage without navigating to Data entry | `data-assurance.spec.ts` |
| 5 | `npm run typecheck` · `@nzi/console` build · full unit suites green | ✅ |

## Verification (DA3a+DA3b+DA3c: PR #86, #87, #88)

- `npm run typecheck` (all workspaces) — clean · `npm run build -w @nzi/console` — green (routes registered).
- `@nzi/contracts` 69/69 · `@nzi/isolated-backend` 237/237 (+2 `createReviewedCrpSnapshot` gap-gate:
  `GAPS_OPEN` blocks, clears once mapped) · `@nzi/console` unit suite 85/85 (unaffected — DA3c UI is covered
  by e2e, not the node:test unit suite).
- Migration `0054_gap_resolution_version` applied to isolated staging + verified (column present). DA3c adds
  no new migration — `job_scope_rows.version`/`reviewer_note` and the DA1/DA3a read models are reused as-is.
- `data-assurance.spec.ts` (9, +2 for DA3c) — skips until `data-assurance` is live; **harden at flip**.

## Flip (DA3a+DA3b+DA3c)

Append `data-assurance` to `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` in the Render dashboard + rebuild; add to
`render.yaml`. Harden `data-assurance.spec.ts` (remove the flag skip), run against deployed staging, record
here + the human pass in `docs/STAGING_ACCEPTANCE_DA3.md`.

## Rollback

Presentational, additive. Remove `data-assurance` + rebuild — Review & QA renders as before. No data / route
/ schema change (DA1's `0052` is already in place and unread without this surface).
