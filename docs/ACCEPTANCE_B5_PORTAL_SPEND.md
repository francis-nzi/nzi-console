# B5 — Portal spend mirror: acceptance & flag gate

> **STATUS: draft for Francis.** Written before the build so "done" is defined up front, in the pattern of
> `ACCEPTANCE_B2_SPEND_ADAPTER.md` and `ACCEPTANCE_B4_IMPORT.md`. Companion to `REDESIGN_ROLLOUT.md`
> (burndown row **B5**), `DECISIONS.md` NZC-016 / NZC-035 / NZC-036, and `GAP_ANALYSIS_DATA_ENTRY.md`
> §2 (spend) / §8 (portal).

**Purpose.** The exit criteria B5 must satisfy before its flag flips. **Scope: the client-portal spend
capture only** — the constrained mirror of the B2 consultant spend adapter (NZC-016, "the portal is a
constrained mirror, not a fork"). It surfaces the **spend** entry kind in the existing portal data-entry
framework so an authorised portal user can enter (and optionally bulk-paste / CSV-import) a spend ledger
into an NZI-authorised Scope 3.1 bucket, producing **draft** entries that travel the **unchanged** portal
submit → independent staff review → canonical row spine.

**Not in B5:** commuting / vehicle portal kinds (S1), the `.xlsx` round-trip (B4 later slice), any change
to the consultant-side spend adapter, any new portal principal capability.

## Why this is small

The portal data-entry framework already exists and already contemplates spend:

- `portal_data_entry_bucket_grants.entry_kind` already includes `'spend'` (migration `0029`), and
  `kindMatchesScope` already binds `spend` → scope `3.1` (`portalDataEntry.ts`).
- Draft → submit → `portal_data_entry_review_queue` → staff `decidePortalDataEntryReview` → write to
  `job_scope_rows` is built and tested (`portalDataEntryRecords.ts`, `portalReview` suite).
- The constrained-mirror guardrails (entry window, allowed factors / sites / units, tenant RLS, optimistic
  concurrency, "submitted ≠ reviewed emissions") are built and enforced.

B5 is therefore: **(a)** a spend-shaped capture surface in the portal (mirroring `SpendLedgerAdapter`),
**(b)** carrying spend detail + the controlled PG&S category through the record and the review-queue write
so the canonical row lands with parity to B2 (Scope 3.1, **Spend-based** tier, PG&S category, `SpendDetail`
provenance), and **(c)** one additive migration for the per-record spend detail. Everything else is reuse.

## Open questions for Francis (decide before build)

- **Q-B5-1 — flag value.** Consultant spend is `spend`; consultant import is `spend-import`. Propose the
  portal mirror is **`portal-spend`** (`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend,spend-import,portal-spend`),
  its own gate and its own flip. Alternative: reuse `spend` so the portal kind lights up wherever the
  consultant adapter is on. **Recommendation: `portal-spend`** — the portal surface earns its own rendered
  acceptance and screen-reader pass, and B2's flip record stays clean.
- **Q-B5-2 — CSV import in the portal.** Include the B4 CSV reader + column-mapper in the portal spend
  surface, or ship B5 as **paste + manual only** and treat portal CSV import as a follow-up? The B4 parser
  is pure and framework-agnostic (`csvReader.ts`, `spendImportMapping.ts`), so reuse is cheap, but the
  portal preflight route + `client_import_mappings` keying (`import_kind`) would need a portal-auth sibling.
  **Recommendation: paste + manual for B5**, portal CSV import as B5.1 once B4's own flip has landed.
- **Q-B5-3 — monthly.** Mirror B2's "split each line into its invoice month across the reporting period"
  toggle in the portal, or portal spend is annual-only for B5? **Recommendation: mirror it** — the storage
  and roll-up already exist (NZC-032) and the portal review write already zeroes `monthly_activity_json`,
  which we would replace with the submitted vector.
- **Q-B5-4 — who assigns the spend bucket.** Confirmed already: a staff user with `portal.access.manage`
  grants a `spend` bucket on a specific Scope 3.1 scope row with an allowed factor set
  (`setPortalDataEntryBucketGrant`). B5 adds **allowed PG&S categories** to that grant (see gate item 6).
  Confirm that is the right control point and not, e.g., "any client PG&S category".

---

## The gate — all must pass before B5's flag flips

### 1. Constrained mirror (NZC-016 / NZC-035)

- [ ] The portal spend surface shows **only** what the bucket grant authorises: the bound Scope 3.1 scope
  row, the allowed factor set, the allowed sites, the allowed units, **and the allowed PG&S categories**.
  No client-wide category or factor list is ever exposed in the portal.
- [ ] Entry is possible **only** while the access grant's data-entry window is open
  (`data_entry_starts_at ≤ now < data_entry_expires_at`); outside it the surface is read-only with an
  explicit scheduled/closed state (not an error, not a silent empty).
- [ ] No new portal capability: the portal user still cannot pick datasets, change factor versions, sync,
  calculate, review, or see other clients' or jobs' data. Tenant RLS + `portal_user_id` + `client_id` +
  `job_id` predicates on every read and write, as today.
- [ ] The consultant-side spend adapter (B2), the B3 rollforward panel, and the generic portal manual-entry
  surface are **unchanged**.

### 2. Spend capture surface (mirror of `SpendLedgerAdapter`)

- [ ] For a `spend`-kind bucket, the portal presents spend fields: **description, net value, VAT %, GL
  code, invoice date (dd/mm/yyyy), PG&S category (from the allowed list), factor (from the allowed list)**.
- [ ] **Paste fast path**: paste ledger rows from a spreadsheet → parsed client-side (reuse
  `parseSpendLedger`) → one editable row per line → per-line category suggestion (single + "suggest all",
  reusing `suggestCategory`, advisory only, NZC-018) → the client confirms category + factor per line →
  add as drafts.
- [ ] **Manual path**: a single-row form for one spend line.
- [ ] Monthly per Q-B5-3.
- [ ] **Five explicit states** in the surface: closed/scheduled · window-open-empty · parsing · drafts
  (with advisories) · submitted. A failed load is never rendered as "no entries".
- [ ] Nothing silently dropped from a paste — every input line appears as an editable draft or a clearly
  flagged unparseable line.

### 3. Record model carries spend detail

- [ ] A portal data-entry record of kind `spend` stores: `net_value`, `vat_percent`, `gl_code`,
  `pgs_category_id` (from the allowed list), `invoice_date`, and (per Q-B5-3) the monthly vector — as an
  additive nullable `detail_json jsonb` (+ a snapshot `entry_kind`) on `portal_data_entry_records`, not a
  widening of the existing scalar columns.
- [ ] `quantity` / `unit` for a spend record are the **net value** and the **currency** (mirroring B2's
  `SpendLedgerAdapter`), so the existing bucket unit/factor validation still applies unchanged.
- [ ] The record validation extends `validate()` in `portalDataEntryRecords.ts`: `pgs_category_id` must be
  in the bucket's allowed categories; `vat_percent` in range; `net_value` finite ≥ 0; `invoice_date`
  parseable and (advisory, not block) within the reporting period.

### 4. Review-queue write lands with B2 parity

- [ ] `decidePortalDataEntryReview` **accept** for a `spend` record writes the canonical `job_scope_rows`
  with: `scope='3.1'`, `quality_tier` = **Spend-based** (not `NULL` as the manual path does), the
  controlled PG&S category, `SpendDetail` (`netValue`, `vatPercent`, `glCode`, `category` label) in the
  provenance/detail, `data_source` naming the portal origin + the portal user + the submitted version, and
  the monthly vector where submitted.
- [ ] Provenance/lineage on the written row is expandable in the evidence drawer exactly as a
  consultant-entered spend row is — factor set/version, data hash, as-at date, `source='client-portal'`.
- [ ] The written row is `review_status='pending'` and `calculated_tco2e=NULL` — submitted portal spend
  **never counts as reviewed emissions** until the independent emissions review (unchanged).
- [ ] Optimistic concurrency: the staff decision is bound to `expectedSubmittedVersion`; a stale decision
  is a 409 with recovery, as today.

### 5. Governed spine unchanged (parity with the manual portal path)

- [ ] Draft → **client submits** → `portal_data_entry_review_queue` (`pending`) → **staff independent
  review** (`emissions.review`) → accept writes the canonical row / reject returns a mandatory note.
- [ ] No auto-submit, no auto-accept, no second write path. The client cannot submit outside the window.
- [ ] Delete / edit only an **owned draft**; a submitted record is read-only to the client.
- [ ] Audit events for create / update / submit / delete / review.accept / review.reject, as today, with
  the spend detail in `after_json`.

### 6. Bucket grant gains allowed PG&S categories

- [ ] `setPortalDataEntryBucketGrant` accepts `allowedPgsCategoryIds` for a `spend`-kind grant; each must
  be a controlled PG&S category for the job's client. Stored on the bucket grant (additive column), audited.
- [ ] `listPortalDataEntryBuckets` returns the allowed categories so the portal surface can render the
  constrained select. A non-`spend` grant ignores the field.
- [ ] The platform `PortalBucketAdmin` staff UI exposes the category multi-select when kind = `spend`.

### 7. Isolation & schema

- [ ] Additive migrations only, RLS + `FORCE ROW LEVEL SECURITY` + tenant policy, migration-owned, applied
  to **isolated staging only** before merge; no request-time DDL. Expected:
  - `portal_data_entry_records`: `entry_kind text NOT NULL DEFAULT 'manual_activity'` (snapshot) +
    `detail_json jsonb` (nullable).
  - `portal_data_entry_bucket_grants`: `allowed_pgs_category_ids text[] NOT NULL DEFAULT '{}'`.
- [ ] `NEXT_PUBLIC_APP_ENV=staging`; no production credentials or data; synthetic fixtures only.
- [ ] Existing manual records are unaffected (new columns take defaults; `detail_json` null).

### 8. Flag behaviour (Q-B5-1)

- [ ] The flag value (proposed `portal-spend`) is **OFF by default**, resolves identically server- and
  client-side, and gates **only** the portal spend surface. With it off, a `spend`-kind bucket falls back
  to the generic portal manual form (or is hidden — decide in build), and every other portal and console
  surface is unchanged. Removing the value instantly restores the prior behaviour.

### 9. Tests & build

- [ ] Pure / contract: spend record validation (category in allowed set, VAT range, net ≥ 0, date parse);
  the paste parser reuse; the five-state machine.
- [ ] Backend: a `spend` bucket grant with allowed categories; a spend draft create/update/submit carrying
  `detail_json`; **review accept writes the canonical row with Spend-based tier + PG&S category +
  `SpendDetail` + monthly**; review reject; negatives (category not in allowed set, out-of-window submit,
  stale `expectedSubmittedVersion`, wrong owner, non-3.1 scope row).
- [ ] Read models: `listPortalDataEntryBuckets` returns allowed categories; `listPortalDataEntryRecords`
  returns spend detail; the staff review queue shows the spend line.
- [ ] Existing suites: `npm run typecheck`, `test:portal`, `test:staff`, contracts + mock-data,
  `build -w @nzi/console` — all green. No new runtime dependency. e2e unaffected with the flag off.

### 10. Accessibility & responsive

- [ ] Paste textarea + per-line grid + category/factor selects: labelled, keyboard-operable, status and
  submit outcome announced (live region), visible focus, contrast-safe, reduced-motion.
- [ ] No horizontal overflow at 390 / 768 / 1280 / 1920. Automated axe + responsive in a portal e2e spec
  (skips until the flag is on a staging deploy, as B4 gate 9).
- [ ] **Rendered screen-reader pass — human-only**, folded into the #22 / A3 / #25 session.

### 11. Standards

- [ ] "carbon emissions" (NZC-039, not "footprint"); dates dd/mm/yyyy (NZC-040), including the paste
  preview, the invoice-date field, and the submitted-entry list.

## Exit

All boxes ticked **plus** `docs/STAGING_ACCEPTANCE_B5.md` (evidence + known limitations + rollback check,
like B2/B3/B4). The flag flip is its **own reviewed change** after a rendered acceptance pass — never
bundled with the build.

## Proposed build order

1. **Docs** — this gate, reviewed and merged (this PR).
2. **Schema + backend** — `0042` record `entry_kind` + `detail_json`; `0043` bucket
   `allowed_pgs_category_ids`; extend `setPortalDataEntryBucketGrant`, `validate()`,
   `listPortalDataEntryBuckets`, `decidePortalDataEntryReview` accept-write; backend tests.
3. **Portal surface** — `PortalSpendEntry` (mirror of `SpendLedgerAdapter`) behind the flag; wire into
   `PortalWorkspace` for `spend`-kind buckets; reuse `parseSpendLedger` / `suggestCategory`.
4. **Staff UI** — `PortalBucketAdmin` category multi-select for `spend` kind.
5. **e2e + `STAGING_ACCEPTANCE_B5.md`**.
6. Separate PR: flip the flag in `render.yaml`.

*Prepared 31 Aug 2026. Extends the B2/B3/B4 gate line. Portal is client-not-live in staging (confirmed
31 Aug 2026), so flag flips can be batched but each surface still earns its own acceptance record.*
