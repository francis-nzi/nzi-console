# B5 — portal spend mirror · acceptance record

Running record against `docs/ACCEPTANCE_B5_PORTAL_SPEND.md`. **The flag
(`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=…,portal-spend`) does not flip until every gate box is ticked,
this record is complete, and the client-facing flip gate (5a) is cleared.** The flip is its own
reviewed change.

## Built (increments)

| # | Increment | PR |
|---|-----------|----|
| 1 | Schema + backend — `0042_portal_spend_mirror.sql` (`entry_kind` + `detail_json` on portal records; `allowed_pgs_category_ids` on the bucket grant); `parsePortalSpendDetail`; spend-aware `setPortalDataEntryBucketGrant` / `validate()` / `listPortalDataEntryBuckets` / `decidePortalDataEntryReview`; backend tests | this PR |
| 2 | Portal `PortalSpendEntry` surface (paste + manual, progressive monthly) behind `portal-spend`; `PortalBucketAdmin` category multi-select; e2e | ⏳ |
| 2.1 | Flip PR — `portal-spend` into `render.yaml` after gate 5a | ⏳ |

## Decision — CSV-first / paste-first (Francis, 31 Aug 2026)

B5 is **paste + manual only**. Client CSV **file upload is B5.1**, its own hardening slice reusing
B4's RFC-4180 parser. See `DECISIONS.md` NZC-036 / NZC-016 amendment.

## Gate status (after increment 1)

| # | Gate item | State |
|---|-----------|-------|
| 1 | Constrained mirror — bucket grant authorises the scope row + allowed factors / sites / units / **PG&S categories**; window-bound; no new portal capability; B2 / B3 / generic path unchanged | ◐ backend enforces the allowed-category boundary; surface is increment 2 |
| 2 | Spend capture surface (paste + manual, five states, progressive monthly, nothing dropped) | ⏳ increment 2 |
| 3 | Record model carries spend detail — `detail_json` (netValue / vatPercent / glCode / pgsCategoryId / invoiceDate / monthlyActivity); `quantity` forced to the net value; `validate()` checks category ∈ allowed set, VAT range, net ≥ 0 | ✅ |
| 4 | Review-queue accept writes the canonical row with **spend-based** tier, the controlled PG&S category, `SpendDetail` + portal-origin provenance, and the submitted monthly vector; row stays `pending` + uncalculated; `expectedSubmittedVersion` optimistic concurrency | ✅ |
| 5 | Governed spine unchanged; factor mapping + sync-to-scope stay staff-side; owned-draft-only edit/delete; audit on every transition | ✅ (spine reused unchanged) |
| 5 | Cross-client isolation / CSRF / rate-limit / stale-session | ◐ query predicates carry `portal_user_id` + `client_id` + `job_id` as today; live two-principal + CSRF + rate-limit + stale-session verification is a gate-5a e2e item (increment 2) |
| 5a | Flip gate — `test:portal` green + portal security items + rendered a11y/screen-reader on staging with the flag on | ⏳ |
| 6 | `allowed_pgs_category_ids` on the bucket grant, validated against the job client's categories, audited; `listPortalDataEntryBuckets` returns them; non-spend grant forced empty | ✅ (staff `PortalBucketAdmin` multi-select is increment 2) |
| 7 | `0042` additive, `CHECK`-constrained, migration-owned; existing manual records unaffected (defaults; `detail_json` null) | ✅ — **apply `0042` to isolated staging before merge** |
| 8 | Flag `portal-spend` OFF by default | ⏳ increment 2 (flag not yet referenced) |
| 9 | Tests: `parsePortalSpendDetail` (category / VAT / net / month); bucket grant with categories + rejection + non-spend drop; spend draft create (quantity = net value, detail persisted) + category-outside-set rejection; review accept → spend-based row + category + monthly + `SpendDetail`; accept blocked when category unconfigured. typecheck · contracts 35 · isolated-backend 175 · console 28 · test:portal 88 · test:staff 30 · `next build` | ✅ |
| 10 | Rendered a11y + responsive of the portal spend surface | ⏳ increment 2 |
| 11 | "carbon emissions" / dd/mm/yyyy | ⏳ increment 2 (surface copy) |

## Remaining before the flip

1. Increment 2 — the portal surface + staff category multi-select + e2e.
2. Apply `0042` to Render staging (manual, before merge of this PR).
3. Gate 5a — portal acceptance suite + human screen-reader pass with `portal-spend` on.
4. Flip PR — `portal-spend` into `render.yaml`.

## Rollback

`0042` is additive: `entry_kind` defaults to `manual_activity`, `detail_json` stays null, and
`allowed_pgs_category_ids` defaults to `'{}'`. With no `portal-spend` flag and no surface reading
`detail_json`, the columns are inert; every existing portal manual record and its review path is
unchanged.
