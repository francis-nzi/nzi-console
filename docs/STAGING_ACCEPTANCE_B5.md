# B5 — portal spend mirror · acceptance record

Running record against `docs/ACCEPTANCE_B5_PORTAL_SPEND.md`. **The flag
(`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=…,portal-spend`) does not flip until every gate box is ticked,
this record is complete, and the client-facing flip gate (5a) is cleared.** The flip is its own
reviewed change.

## Built (increments)

| # | Increment | PR |
|---|-----------|----|
| 1 | Schema + backend — `0042_portal_spend_mirror.sql` (`entry_kind` + `detail_json` on portal records; `allowed_pgs_category_ids` on the bucket grant); `parsePortalSpendDetail`; spend-aware `setPortalDataEntryBucketGrant` / `validate()` / `listPortalDataEntryBuckets` / `decidePortalDataEntryReview`; backend tests | #34 ✅ merged + deployed |
| 2 | `portal-spend` flag; `getPortalDataEntryAccess` returns `reportingMonths`; `PortalSpendEntry` surface (paste + manual, progressive monthly split) wired into `PortalWorkspace` for spend-kind buckets; `PortalBucketAdmin` PG&S category multi-select; `portal-data-entry-buckets` + portal `data-entry-records` routes carry `pgsCategoryIds` / `detail`; portal e2e (`portal-spend.spec.ts`) | this PR |
| 2.1 | Flip PR — `portal-spend` into `render.yaml` after gate 5a | ⏳ |

## Decision — CSV-first / paste-first (Francis, 31 Aug 2026)

B5 is **paste + manual only**. Client CSV **file upload is B5.1**, its own hardening slice reusing
B4's RFC-4180 parser. See `DECISIONS.md` NZC-036 / NZC-016 amendment.

## Gate status (after increment 2)

| # | Gate item | State |
|---|-----------|-------|
| 1 | Constrained mirror — bucket grant authorises the scope row + allowed factors / sites / units / **PG&S categories**; window-bound; no new portal capability; B2 / B3 / generic path unchanged | ✅ surface shows only `bucket.pgsCategories` / `bucket.factors`; renders only while `access.state==="open"`; generic manual surface handles all non-spend kinds unchanged |
| 2 | Spend capture surface (paste + manual, progressive monthly, nothing dropped) | ✅ `PortalSpendEntry` — paste (reuses `parseSpendLedger`) + blank-line add; per-line category (advisory `suggestCategory`) + factor from the authorised sets; **progressive monthly**: `<details>` collapsed → annual, open → reporting-period month inputs; every parsed line becomes an editable draft |
| 3 | Record model carries spend detail — `detail_json`; `quantity` forced to the net value; `validate()` checks category ∈ allowed set, VAT range, net ≥ 0 | ✅ |
| 4 | Review-queue accept writes the canonical row with **spend-based** tier, the controlled PG&S category, `SpendDetail` + portal-origin provenance, and the submitted monthly vector; row stays `pending` + uncalculated; `expectedSubmittedVersion` optimistic concurrency | ✅ |
| 5 | Governed spine unchanged; factor mapping + sync-to-scope stay staff-side; owned-draft-only edit/delete; audit on every transition | ✅ surface saves **drafts**; submit/delete go through the unchanged portal record routes; the client never syncs or calculates |
| 5 | Cross-client isolation / CSRF / rate-limit / stale-session | ◐ every write reuses the existing portal record routes (same-origin guard + `portal_user_id`/`client_id`/`job_id` predicates + `redirectIfPortalSessionEnded`); **live two-principal + CSRF + rate-limit verification is gate 5a** |
| 5a | Flip gate — `test:portal` green + portal security items + rendered a11y/screen-reader on staging with the flag on | ⏳ |
| 6 | `allowed_pgs_category_ids` on the bucket grant, validated against the job client's categories, audited; `listPortalDataEntryBuckets` returns them; non-spend grant forced empty; staff multi-select | ✅ `PortalBucketAdmin` shows the PG&S multi-select when entry type = spend |
| 7 | `0042` additive, `CHECK`-constrained, migration-owned; existing manual records unaffected | ✅ — **`0042` applied to isolated staging with #34** |
| 8 | Flag `portal-spend` OFF by default; with it off a spend bucket falls back to the generic portal manual form | ✅ `dataEntryAdapterEnabled("portal-spend")` gates the surface; off → the spend bucket flows through `PortalEntryRecords` as today |
| 9 | Tests (backend) | ✅ isolated-backend 176 · test:portal 89 · test:staff 30 · contracts 35 · console 28 · typecheck · `next build` |
| 10 | Rendered a11y + responsive of the portal spend surface | ◐ automated axe + no-overflow in `portal-spend.spec.ts` (skips until a portal account + `portal-spend` on a staging deploy); **human screen-reader pass is gate 5a** |
| 11 | "carbon emissions" / dd/mm/yyyy | ✅ surface copy says "carbon emissions"; dates via the shared `formatDate` (dd/mm/yyyy) |

## Remaining before the flip

1. Set `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=…,portal-spend` on Render staging (dashboard) → the automated
   `#portal-spend-entry` scan (gate 10) runs.
2. Gate 5a — `test:portal` green, live cross-client / CSRF / rate-limit / stale-session checks, human
   screen-reader pass with `portal-spend` on.
3. Flip PR — `portal-spend` into `render.yaml`.
4. B5.1 — client CSV upload (its own hardening slice).

## Rollback

`0042` is additive: `entry_kind` defaults to `manual_activity`, `detail_json` stays null, and
`allowed_pgs_category_ids` defaults to `'{}'`. With no `portal-spend` flag and no surface reading
`detail_json`, the columns are inert; every existing portal manual record and its review path is
unchanged.
