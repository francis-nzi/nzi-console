# DA1 — Data Assurance backend · acceptance

Track: **M8 · Data Assurance** (`docs/_handoff_DATA_ASSURANCE_brief.md` §4–5). Decisions **NZC-059 / NZC-060**.
Backend only, additive — **no flag**. Feeds DA3 (the assurance surface).

## Parts

| Part | Scope | Status |
|---|---|---|
| DA1a | **Baseline / prior-year resolution** — `buildReportingChain` + `resolveCrpReportingChain` read model | 🟢 built — **proposal in this PR for Francis to confirm** |
| DA1b | Multi-year aggregation read models (scope→category→activity, by-site, intensity, per year) | ⏳ held until DA1a is confirmed |
| DA1c | Gap-engine computation — the four NZC-060 flag types over the trend | ⏳ held |
| DA1d | Gap-resolution store — resolved-with-reason (who / when / reason) keyed to row + flag, on provenance; new additive migration | ⏳ held |
| DA1e | Sign-off / snapshot — extend the reviewed-snapshot record (not fork it) to carry the resolved-gap record so sign-off is reproducible | ⏳ held |

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
| 6 | `npm run typecheck` · full suites green | ✅ |
| 7 | DA1b–e (aggregation, gap engine, gap store, sign-off extension) | ⏳ after DA1a confirmed |

## Verification (this PR)

- `npm run typecheck` — clean.
- `@nzi/contracts` 61/61 (6 new) · `@nzi/isolated-backend` +5 (reportingChain).
- No migration in DA1a. DA1d adds one (additive) — applied to staging + schema-probed before its deploy.
