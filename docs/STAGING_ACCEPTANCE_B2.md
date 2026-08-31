# B2 — spend ledger adapter · acceptance record

Running record against `docs/ACCEPTANCE_B2_SPEND_ADAPTER.md`. **The flag
(`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend`) does not flip until every box is ticked**
and this record is complete (evidence + known limitations + rollback), per the gate's
Exit clause. The flip is its own reviewed change, separate from the build PRs.

## Increment 1 — flagged adapter skeleton (30 Aug 2026)

Built behind the flag, OFF by default. Current generic data-entry path unchanged (e2e
39/39 with the flag off). CRP/consultant side only.

**In this increment**

- `apps/console/app/jobs/SpendLedgerAdapter.tsx` — paste a ledger → editable line grid
  (description, net, VAT %, GL code, invoice date) → confirm a controlled PG&S category
  (datalist of the job's categories + a deterministic keyword suggestion, advisory) and a
  Scope-3 factor per line → import.
- Import creates a `job_emission_sources` spend source per line (`source_type='spend'`,
  `scope='3.1'`, `SpendDetail`) then syncs it.
- `syncEmissionSourceToScope` now carries **`quality_tier='spend-based'`** for
  `source_type='spend'` (was `NULL`) — new `postgresCommands.test.ts` case.
- `apps/console/app/lib/featureFlags.ts` — `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` (comma list),
  resolved identically server/client; `apps/console/app/lib/formatDate.ts` — the shared
  dd/mm/yyyy formatter (NZC-040).
- `spendLedger.ts` pure parser + suggestion, unit-tested (`apps/console/tests/spendLedger.test.ts`).

## Gate status

| # | Gate item | State |
|---|---|---|
| 1 | Sync to Scope 3.1 · **Spend-based tier** | ✅ |
| 1 | Controlled **PG&S category** on the synced row (NZC-033) | ✅ **Increment 2** — migration `0038` adds `job_emission_sources.purchased_goods_category_id` (FK to `purchased_goods_categories`, same as the manual scope-row path); `emission.source.create` requires it for `sourceType='spend'` and validates it against the job's client; `syncEmissionSourceToScope` carries it into `job_scope_rows.purchased_goods_category_id`. The adapter's category is now a `<select>` of the job's controlled categories, not free text |
| 1 | Provenance (ledger source + mapping + factor set/version + **data hash + as-at date**) + lineage | ✅ **Increment 3** — `syncEmissionSourceToScope` provenance now carries `factorSet`, `factorVersion`, `asAt`, and a `dataHash` (`sha256:` of the source's identifying content: id, scope, qty, unit, factor, version, PG&S category, apply %, detail, monthly). Lineage gains an "Evidence identity" line. Re-syncing unchanged data yields the same hash |
| 1 | **Monthly** where the ledger carries it (NZC-032) | ✅ **Increment 4** — a spend line carries one invoice date, so its whole net value lands in that calendar month. When the job has a reporting period, the adapter offers "split each line into its invoice month" (on by default); the import sends the period-spanning slot vector and `emission.source.create` now resolves + validates it (period match, in order) and derives the annual quantity — the same `resolveSourceMonthlyActivity` path as the manual register. An invoice date outside the period is flagged advisory and imported as an annual value |
| 1 | Re-sync idempotent, stable row identity, versioned mappings | ✅ (existing `0037` unique index + source-locked upsert) |
| 2 | **Upload** ledger → preview → commit | ◐ **paste** + preview + commit; file upload is NZC-036 / Phase 3 |
| 2 | Category suggestion **single + bulk** | ✅ **Increment 4** — per-row "Suggest: …" plus a "Suggest all categories" action that fills every empty row from the grounded keyword match; still advisory, never auto-applied on parse |
| 2 | Previous-year rollforward re-pins prior factor versions (NZC-030) | ⛔ B3 |
| 2 | Duplicate-key + anomaly (YoY, unit sanity) advisory flags | ◐ **Increment 3** — the adapter flags within-paste duplicate lines (description + net + GL) and non-positive net values as **advisory** notes (never blocks import, NZC-018). YoY variance needs prior-year data (B3) |
| 3 | AI guardrails (grounded, confidence shown, human confirms, never a 2nd write path) | ◐ deterministic keyword suggestion grounded in the client's own PG&S categories; advisory; human confirms. No confidence score; not "AI" |
| 4 | Governance spine unchanged (review bound to version, five states, optimistic concurrency, never auto-reviewed) | ✅ reuses `emission.source.create` + `emission.source.sync`; adapter renders empty/parsed/importing/failed/done |
| 5 | Isolation — staging only, migration-owned, no request-time DDL | ✅ Increment 2 adds migration `0038` (additive, nullable column + FK) — apply to isolated staging via the runbook below; no request-time DDL |
| 6 | Flag OFF by default, server = client, instant off-restore | ✅ (e2e 39/39 flag-off) |
| 7 | Tests: sync-to-scope ✅ · mapping ✅ · monthly-on-create ✅ · rollforward re-pin ⛔ (B3) · idempotency ◐ · negative journeys ✅ (spend without a category → `REQUIRED`; category not on the job's client → `NOT_FOUND`; malformed monthly slots → `REPORTING_PERIOD_MISMATCH`; junk ledger → dropped) | ◐ |
| 7 | typecheck · console/portal/staff node tests · build | ✅ (+ contracts 22, mock-data 20, isolated-backend 147, console 11, staff/portal 32) |
| 8 | Rendered a11y + responsive review of the spend grid | ◐ **scanned 31 Aug 2026** on flagged staging (`apps/console/tests/e2e/spend-adapter.spec.ts` — drives the parsed grid, axe WCAG 2.1 A/AA + no-overflow at 390/768/1280/1920). Responsive ✅. Axe found two real defects, **fixed in this PR**: (a) every editable grid cell input (description, net, VAT %, GL code) had no accessible name (WCAG 4.1.2) → per-row `aria-label`; (b) "Use sample" was `disabled` until the textarea was non-empty, so it could never seed the empty state → always enabled. Re-scan goes green once this PR deploys |
| 9 | "carbon emissions" / dd/mm/yyyy | ✅ `formatDate` used; copy compliant |
| 10 | Sites / NZC-042 | ✅ **N/A** — spend sources are created site-less; no site field; no site-scoped factor logic. NZC-042 not implicated |

## Increment 2 — controlled PG&S category (30 Aug 2026)

Migration `0038_emission_source_purchased_goods_category.sql` (additive, nullable + FK).
**Apply to isolated staging only**, like 0034–0037:

```
psql "$NZI_ISOLATED_DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/isolated-backend/migrations/0038_emission_source_purchased_goods_category.sql
```

`emission.source.create` gains `purchasedGoodsCategoryId` (required for spend, validated against
the job's client); `syncEmissionSourceToScope` carries it into the canonical row's existing
`purchased_goods_category_id` FK; the spend adapter picks from the job's controlled categories.

## Increment 4 — monthly split, bulk suggestion, negative journeys (31 Aug 2026)

- `emission.source.create` now runs the same monthly-activity resolution as the
  register edit path (`resolveSourceMonthlyActivity`): slots must span the reporting
  period once, in order; the annual quantity is derived from the populated months.
  `monthlyActivityIssues` also runs in the contract `validate()`.
- `spendLedger.ts` gains the pure `monthlySlotsForLine(invoiceDate, netValue,
  reportingMonths)` helper; the adapter uses it behind a default-on "split by invoice
  month" toggle and a "Suggest all categories" bulk action.
- `CrpScopeWorkspace` passes the job's reporting months (from the selected dataset
  period) to the adapter.
- New tests: contract `emission.source.create` (spend category `REQUIRED`, monthly
  slot identity, detail-kind match); `postgresCommands` create-with-monthly derives
  the annual quantity and rejects a non-spanning period; `spendLedger` junk-ledger
  and `monthlySlotsForLine` cases.

This increment also carries the Increment 3 content (evidence identity + advisory
flags) that a stacked-PR merge order left off `main`.

## Increment 5 — gate 8 rendered acceptance (31 Aug 2026)

`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend` set on the Render staging service (dashboard
env, not `render.yaml` — the committed flip stays separate). New `spend-adapter.spec.ts`
drives the parsed grid and scans it. Responsive ✅ at all four viewports. Two axe defects
found and fixed here (grid input `aria-label`s; "Use sample" always enabled). **The
gate-8 re-scan is the last open item — it clears once this PR deploys.**

### Incident — register 503 (31 Aug 2026)

Migration `0038` (from increment 2, PR #11) had **not** actually reached the isolated
staging database, but the read model that selects `s.purchased_goods_category_id`
(also #11) was merged and deployed. Result: `GET /jobs/{id}/emission-sources` returned
503 for **every job family**, not just CRP — "The source register is unavailable" on
the workspace. `0038` has now been applied to isolated staging (additive: nullable
column + FK to `purchased_goods_categories`); all job registers return 200 again.
Two process fixes in this PR: `apiFailure`/`commandFailure` now log the underlying
cause server-side (it was being discarded, so the outage was invisible without a DB
probe). Standing rule reaffirmed: a schema-dependent read/write must not merge ahead
of its migration being confirmed on staging.

## Remaining before the flag flips

1. **This PR deploys → re-run `spend-adapter.spec.ts` → gate 8 goes ✅** (green locally
   against the fix; currently red vs staging only on the two defects this PR fixes).
2. Previous-year rollforward with factor-version re-pin — coordinate with B3 (gate 2).
3. YoY variance advisory flag — needs prior-year data (B3, gate 2).
4. Rollback check (flag OFF → generic path returns; nothing else to undo).

Once gate 8 is ✅ and this record is complete, the flag flip is its own reviewed PR
(add `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend` to `render.yaml`) — never bundled with a
build.

## Rollback

Flag is OFF; nothing to roll back. When enabled, unset `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`
and redeploy — the generic path returns instantly. The `quality_tier='spend-based'` sync
change affects only `source_type='spend'` rows, of which there are none until the flag is on.
