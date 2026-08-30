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
| 1 | Controlled **PG&S category** on the synced row (NZC-033) | ⛔ category captured as `detail.category` string only; `job_scope_rows.purchased_goods_category_id` stays NULL — needs an additive column on `job_emission_sources` + carry-through |
| 1 | Provenance (ledger source + mapping + factor set/version + **data hash + as-at date**) + lineage | ◐ provenance carries sourceId/dataSource/detail/factor source; **no data hash / as-at date** yet |
| 1 | **Monthly** where the ledger carries it (NZC-032) | ⛔ not in this increment (ledger has an invoice date only; monthly split TBD) |
| 1 | Re-sync idempotent, stable row identity, versioned mappings | ✅ (existing `0037` unique index + source-locked upsert) |
| 2 | **Upload** ledger → preview → commit | ◐ **paste** + preview + commit; file upload is NZC-036 / Phase 3 |
| 2 | Category suggestion **single + bulk** | ◐ single only |
| 2 | Previous-year rollforward re-pins prior factor versions (NZC-030) | ⛔ B3 |
| 2 | Duplicate-key + anomaly (YoY, unit sanity) advisory flags | ⛔ not yet |
| 3 | AI guardrails (grounded, confidence shown, human confirms, never a 2nd write path) | ◐ deterministic keyword suggestion grounded in the client's own PG&S categories; advisory; human confirms. No confidence score; not "AI" |
| 4 | Governance spine unchanged (review bound to version, five states, optimistic concurrency, never auto-reviewed) | ✅ reuses `emission.source.create` + `emission.source.sync`; adapter renders empty/parsed/importing/failed/done |
| 5 | Isolation — staging only, migration-owned, no request-time DDL | ✅ (no new schema in this increment) |
| 6 | Flag OFF by default, server = client, instant off-restore | ✅ (e2e 39/39 flag-off) |
| 7 | Tests: sync-to-scope ✅ · mapping ⛔ · rollforward re-pin ⛔ · idempotency ◐ · integration journey + negatives ⛔ | ◐ |
| 7 | typecheck · test:portal · test:staff · build | ✅ (+ contracts 21, mock-data 20, isolated-backend 143, console 6) |
| 8 | Rendered a11y + responsive review of the spend grid | ⛔ not yet (needs a flagged staging deploy + a scan) |
| 9 | "carbon emissions" / dd/mm/yyyy | ✅ `formatDate` used; copy compliant |
| 10 | Sites / NZC-042 | ✅ **N/A** — spend sources are created site-less; no site field; no site-scoped factor logic. NZC-042 not implicated |

## Remaining before the flag flips

1. Additive `purchased_goods_category_id` on `job_emission_sources` + carry it into the synced row (gate 1).
2. Monthly split for spend where present (gate 1).
3. Provenance data-hash + as-at date (gate 1).
4. Bulk category suggestion; duplicate-key + YoY/unit-sanity advisory flags (gate 2).
5. Previous-year rollforward with factor-version re-pin — coordinate with B3 (gate 2).
6. Mapping / idempotency / negative-journey tests (gate 7).
7. Flagged staging deploy → rendered a11y + responsive review of the spend grid → this record (gate 8).
8. Rollback check.

## Rollback

Flag is OFF; nothing to roll back. When enabled, unset `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`
and redeploy — the generic path returns instantly. The `quality_tier='spend-based'` sync
change affects only `source_type='spend'` rows, of which there are none until the flag is on.
