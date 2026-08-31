# B4 — spend CSV import · acceptance record

Running record against `docs/ACCEPTANCE_B4_IMPORT.md`. **The flag
(`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend-import`) does not flip until every box is ticked**
and this record is complete. The flip is its own reviewed change.

## Built (increments 1–3)

| # | Increment | PR |
|---|---|---|
| 1 | `@nzi/contracts` — identity shape + encode/decode + five preflight states + row-review types | #29 |
| 2 | `@nzi/isolated-backend` — issue/verify token (HMAC, key domain-separated from the session secret); `0040` `import_batch_id` + soft-void columns; `commitSpendImport` / `voidSpendImportBatch` | #30 |
| 3a | Console pure — `csvReader.ts` (RFC-4180, delimiter/BOM detection, formula-injection neutralisation), `spendImportMapping.ts` (auto-map + apply + resolve + named map), `spendImportTemplate.ts` (CSV template) | #31 |
| 3b | `0041` `client_import_mappings` (RLS, tenant-isolated); `saveClientImportMapping` command + `getClientImportMapping`; GET template (client-side) / POST preflight / POST commit / POST void / GET+PUT mapping routes; `SpendImportPanel` behind `spend-import`; e2e | this PR |

## Decision — CSV-first (Francis, 31 Aug 2026)

`exceljs` on install pulled ~98 transitive packages + a transitive moderate `uuid` CVE (not
reachable in our use) against a zero-dependency console. **B4 ships CSV-first with no new
dependency.** The `.xlsx` round-trip and the reporting-period month columns are a later slice.
See `DECISIONS.md` NZC-036 B4 amendment.

## Gate status

| # | Gate item | State |
|---|---|---|
| 1 | Identity shape/encode/decode in contracts; issue/verify in backend; CSV template | ✅ |
| 2 | Preflight: context token verified against job / period / template version; content row review; five explicit states; **nothing silently dropped** (every row shown accepted / advisory / blocked with its number + reason); advisories never block (NZC-018) | ✅ |
| 3 | In-browser parse (no dependency) → normalised rows only to the server; CSV round-trip + paste; column-mapper **remembered per `(client, spend)`** in `client_import_mappings`, versioned + audited; commit tags every row with one `import_batch_id` | ✅ |
| 4 | Governance spine unchanged — imported rows are pending + unsynced; **audited soft-void** limited to pending/unsynced/unreviewed rows (synced/reviewed skipped with a count); no hard delete | ✅ |
| 5 | Size / row cap (5 MB / 10,000) in the browser; CSV-injection cells prefixed on read; real CSV reader; server accepts **only JSON rows** (never a file), behind same-origin + staff auth + tenant scope | ✅ |
| 6 | Migrations `0040` + `0041` additive, RLS + migration-owned, applied to isolated staging; no request-time DDL | ✅ |
| 7 | Flag `spend-import` OFF by default; `spend` (B2/B3) unchanged | ✅ (e2e flag-off) |
| 8 | Tests: CSV reader / mapper / template (console) · token verify · commit/void · mapping save · migrations. typecheck · contracts 35 · mock-data 20 · isolated-backend 166 · console 28 · test:portal 80 · test:staff 30 · `next build` | ✅ |
| 9 | Rendered a11y + responsive of `#spend-import` — automated axe + no-overflow in `spend-adapter.spec.ts` | ◐ runs once `spend-import` is on a staging deploy |
| 9 | **Rendered screen-reader pass — human-only** | ⛔ new issue, folds into the #22 / A3 / #25 session |
| 10 | "carbon emissions" / dd/mm/yyyy (template + preview) | ✅ |

## Remaining before the flip

1. Deploy this PR → set `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend,spend-import` on Render staging
   (dashboard) → the automated `#spend-import` axe + responsive scan (gate 9) runs.
2. Human screen-reader pass of the panel.
3. Rollback check (flag off → panel gone; `0040`/`0041` inert).

## Rollback

Remove `spend-import` from `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` and redeploy — the panel
disappears; `spend` (B2/B3) is untouched. Migrations `0040`/`0041` are additive: any imported
`import_batch_id` rows remain ordinary pending spend sources; `client_import_mappings` is inert
when nothing reads it.

## Known limitations

- `.xlsx` round-trip + reporting-period month columns in the template — later slice.
- Monthly split for an imported row (B2's invoice-month split) — the import path currently
  imports the annual net value only.
- YoY advisory on imported rows applies only to rows linked to a rolled-forward prior source.
