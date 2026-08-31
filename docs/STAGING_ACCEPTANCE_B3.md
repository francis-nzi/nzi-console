# B3 — previous-year rollforward · acceptance record

Running record against the **B3 section of `docs/ACCEPTANCE_B2_SPEND_ADAPTER.md`**. B3 rides the
flag that is already on (`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend`) — **no flag change**.

> **STATUS: MERGED + DEPLOYED 31 Aug 2026** (PRs #24 rollforward, #26 YoY advisory).
> `/api/health` ok; `GET /jobs/{id}/spend-rollforward` and the register (new `prior` join +
> YoY columns) return 200; the rollforward panel renders flag-on at `/jobs/[id]`. Full e2e
> **42/42 on staging** including the B3.9 axe scan of `#spend-rollforward` — 0 violations.
> Remaining: #25 (rollforward-panel screen-reader pass — human-only).

## What shipped

A **"Roll forward last year's spend"** panel in the CRP workspace's spend area (behind the
`spend` adapter flag, next to the ledger adapter). It:

- resolves the **most recent prior CRP job for the same client** with enabled spend sources
  (or an explicit `fromJobId`), and shows an explicit empty state when there is none;
- previews each prior spend mapping — description, GL code, controlled PG&S category, factor
  label, **pinned factor version**, and a **"factor version moved"** marker where the target
  job now selects a different version of that dataset;
- on **Roll forward**, copies each not-yet-rolled-forward mapping into a fresh
  `job_emission_sources` spend row: same `source_name` / GL code / PG&S category (re-validated
  against the client; nulled if the category was removed) / `SpendDetail` (`netValue` reset to
  0) / `scope='3.1'` / `apply_pct`, **`quantity` NULL**, `review_status='pending'`,
  `data_source='Rolled forward from J0006xx · FY2025'`;
- **re-pins the factor** by copying the prior source's exact `factor_source` + `dataset_id` +
  `factor_id` + `client_factor_id`. If that dataset version is not in the target job's
  selections, it is added as a **`manual`** selection with an audited reason citing the origin
  job and NZC-030 — so `emission.source.create`/sync validation is unchanged;
- is **idempotent** — a partial unique index on `(organisation_id, job_id,
  rolled_forward_from_source_id)` plus a pre-filter means a re-run adds nothing.

Rolled-forward rows then go through the **unchanged** sync → calculate → independent-review
spine. Nothing is auto-reviewed. The register and the preview surface `factorVersionMoved` as
an **advisory** (NZC-018) — it never blocks; the re-review is enforced by the pending state.

## Schema

`0039_emission_source_rollforward_origin.sql` — additive: nullable
`job_emission_sources.rolled_forward_from_source_id`, self-FK, partial unique index. Applied to
isolated staging 31 Aug 2026 (column + index + FK verified). No request-time DDL. The
register read-model SQL (which gained a `factor_version_moved` sub-select and the new column)
was smoke-tested against the live schema — no error.

## Gate status

| # | Gate item | State |
|---|---|---|
| B3.1 | Prior-year resolution (most-recent prior CRP job w/ spend; explicit empty state; `fromJobId` override validated) | ✅ |
| B3.2 | Mapping copy (name, GL, category, `SpendDetail` w/ `netValue`=0, scope, apply %; **no quantity**; origin in `data_source`) | ✅ |
| B3.3 | Factor-version re-pin (exact `dataset_id`/`factor_id`/`client_factor_id`; superseded dataset added to selections with an audited NZC-030 reason) | ✅ |
| B3.4 | Moved-version flag → re-review (advisory `factorVersionMoved` in register **+ preview**; never blocks; pending state + independent review enforce the re-review) | ✅ |
| B3.4 | **YoY variance advisory** (#19) — a rolled-forward source carries the prior year's quantity (`yoyPriorQuantity`/`yoyPriorUnit` via the `rolled_forward_from_source_id` join); `apps/console/app/jobs/yoyVariance.ts` flags a swing outside 50–200% in the register, advisory only (NZC-018), unit-tested | ✅ |
| B3.5 | Idempotency & safety (partial unique index + pre-filter; atomic command; CRP + tenant guard) | ✅ |
| B3.6 | Governance spine unchanged (no auto-review/sync; five states in the panel; concurrency + review = B2) | ✅ |
| B3.7 | Isolation & schema (one additive migration `0039`; no request-time DDL; applied to staging) | ✅ |
| B3.8 | Tests & build (contract validate; backend copy/re-pin/no-prior-year/idempotent; read-model rolled-forward + YoY mapping; `yoyVariance` pure helper; migration; SQL smoke; typecheck · test:portal 80 · test:staff 30 · contracts 23 · mock-data 20 · console 16 · isolated-backend 152 · `next build`) | ✅ |
| B3.9 | Accessibility & responsive (automated axe of `#spend-rollforward` + no-overflow in `apps/console/tests/e2e/spend-adapter.spec.ts`) | ✅ automated — deployed, e2e 42/42, 0 axe violations on the panel |
| B3.9 | **Rendered screen-reader pass — human-only** | ⛔ folded into the #22 / A3 session — new issue |
| B3.10 | Standards ("carbon emissions"; dd/mm/yyyy) | ✅ copy compliant; no dates rendered in this panel |

## Known limitations

- **Client-factor version drift** is not surfaced as `factorVersionMoved` (dataset factors
  only). The re-pin itself works for client factors (`client_factor_id` copied verbatim).
- Amounts are deliberately not carried; a consultant re-enters this year's figures. This is by
  design (rollforward carries the mapping, not the data).
- YoY variance advisory (#19) covers **rolled-forward** sources (explicit
  `rolled_forward_from_source_id` link). Matching a freshly *pasted* ledger line to a
  prior-year source by description/category is a later refinement.

## Rollback

No flag change. To disable: the panel is gated by the same `spend` adapter flag — removing
`spend` from `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` hides it with the ledger adapter. Migration
`0039` is additive and inert (nullable column); rolled-forward rows are ordinary pending spend
sources and remain valid if the flag is later removed.
