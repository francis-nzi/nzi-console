# DA1 — Data Assurance backend · acceptance

Track: **M8 · Data Assurance** (`docs/_handoff_DATA_ASSURANCE_brief.md` §4–5). Decisions **NZC-059 / NZC-060**.
Backend only, additive — **no flag**. Feeds DA3 (the assurance surface).

## Parts

| Part | Scope | Status |
|---|---|---|
| DA1a | **Baseline / prior-year resolution** — `buildReportingChain` + `resolveCrpReportingChain` read model | 🟢 confirmed (Francis, 4 Sep 2026) + merged (PR #83) |
| DA1b | Multi-year aggregation — `aggregateAssuranceYear` (by scope / category / site / intensity, per year) + `resolveAssuranceTrend` read model (prior years from frozen snapshot payload, current year snapshot-or-live) + `percentVsBaseline` | 🟢 built |
| DA1c | Gap-engine computation — `computeAssuranceGaps` (the four NZC-060 flag types) + `percentVsBaselineTone` (grey % when driven by an unresolved completeness/zero-blank/unmapped flag) | 🟢 built |
| DA1d | Gap-resolution store — migration `0052_gap_resolutions` (RLS-forced, tenant-isolated, `UNIQUE (org, job_id, gap_key)`, non-deletable) + `assurance.gap.resolve` command (upsert) + `listGapResolutions` read model + `POST /api/isolated/assurance/gaps/resolve` | 🟢 built; migration applied to staging + verified |
| DA1e | Sign-off / snapshot — `report.snapshot.create` payload now freezes `gapResolutions` (additive); read models expose `snapshot.gapResolutions`. **The sign-off *gate* (block while any gap open) lands in DA3** behind `data-assurance`, where the sign-off UI is. | 🟢 payload extension built; gate → DA3 |
| — | `GET /api/isolated/jobs/[jobId]/assurance` → `{ trend, gaps, resolutions }` (the DA3 surface consumes this) | 🟢 built |

## DA1a — baseline / prior-year resolution (proposed)

**How a CRP job finds its baseline year and comparison years:**

- **Baseline year** = the job's emissions-target `baseline_year` (`job_emissions_targets`). No target ⇒ no
  baseline (`baselineYear: null`): the trend shows current + priors only, no BL pill, no "% vs BL".
- **Prior years** = the reviewed CRP snapshots for the **same `client_id`** with `job_family = 'crp'` and
  `reporting_year < current`, **one per distinct year** (latest `snapshot_version` wins — the exact rule the
  existing `annualComparison` query in `report.snapshot.create` already uses). The trend carries the
  **baseline year + the three most recent prior years** strictly between baseline and current.
- **Current year** = the job's own `reporting_year`; its latest reviewed snapshot if one exists, else
  `source: "live"` (the unreviewed job figures the assurance surface is working on).
- **No new column on `jobs`.** The chain is client + reporting-year sequence — an explicit
  `baseline_job_id` reference is deliberately **not** introduced. Gaps in the year sequence are tolerated
  (only the years that exist appear, plus baseline + current always as entries).

`CrpReportingChain` (`@nzi/contracts/dataAssurance.ts`): `{ jobId, clientId, currentYear, baselineYear,
entries: [{ year, kind: baseline|prior|current, snapshotId, dataHash, source: reviewed-snapshot|live|none }] }`,
entries ascending by year.

## Gate

| # | Item | Check |
|---|---|---|
| 1 | Chain orders baseline + ≤3 recent priors + current, ascending | `packages/contracts/tests/dataAssurance.test.ts` |
| 2 | Baseline year with no snapshot → entry present, `source: "none"` | contracts test |
| 3 | No target → no baseline entry, no BL | contracts test |
| 4 | Baseline year never double-counted as a prior; gaps tolerated | contracts test |
| 5 | Read model resolves target + prior snapshots + current snapshot; non-CRP job → null | `packages/isolated-backend/tests/reportingChain.test.ts` |
| 6 | `aggregateAssuranceYear` — totals by scope / category / site / intensity; `source:"none"` year is null | contracts test |
| 7 | `computeAssuranceGaps` — all four flag types fire on a fixture (zeroed category, category gone vs prior, >2× swing, unmapped row); a resolution clears the open state but keeps the reason visible; no prior data ⇒ no YoY/completeness | `packages/contracts/tests/dataAssurance.test.ts` |
| 8 | `percentVsBaselineTone` — a reduction driven by an unresolved completeness/zero-blank/unmapped flag → neutral; resolved or YoY-only → normal (NZC-060) | contracts test |
| 9 | `assurance.gap.resolve` — new resolution keyed job + gap_key; re-resolve overwrites; blank reason / bad flag / non-CRP rejected | `packages/isolated-backend/tests/assuranceGap.test.ts` |
| 10 | Migration `0052` invariants (tenant-isolated, keyed, non-deletable) | `migrations.test.ts` |
| 11 | `npm run typecheck` · `@nzi/console` build · full suites green | ✅ |

## Verification (this PR)

- `npm run typecheck` — clean · `npm run build -w @nzi/console` — green (2 new routes).
- `@nzi/contracts` 68/68 (13 new) · `@nzi/isolated-backend` 231/231 (+9) · console 85/85 · portal 89/89 · staff 33/33.
- Migration `0052_gap_resolutions` **applied to isolated staging + verified** (table + RLS policy) — required because `report.snapshot.create` now reads `gap_resolutions` via `listGapResolutions`.
