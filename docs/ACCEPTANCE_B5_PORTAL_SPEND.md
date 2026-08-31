# B5 — Portal spend mirror: acceptance & flag gate

> **STATUS: directions confirmed by Francis 31 Aug 2026** (D-B5-1..4 below). Ready to build. In the
> pattern of `ACCEPTANCE_B2_SPEND_ADAPTER.md` and `ACCEPTANCE_B4_IMPORT.md`. Companion to
> `REDESIGN_ROLLOUT.md` (burndown row **B5**), `DECISIONS.md` NZC-016 / NZC-035 / NZC-036, and
> `GAP_ANALYSIS_DATA_ENTRY.md` §2 (spend) / §8 (portal).

**Purpose.** The exit criteria B5 must satisfy before its flag flips. **Scope: the client-portal spend
capture only** — the constrained mirror of the B2 consultant spend adapter (NZC-016, "the portal is a
constrained mirror, not a fork"). It surfaces the **spend** entry kind in the existing portal data-entry
framework so an authorised portal user can key or **paste** a spend ledger into an NZI-authorised
Scope 3.1 bucket, producing **draft** entries that travel the **unchanged** portal submit → independent
staff review → canonical row spine.

**Not in B5:** client **file upload** (CSV) — that is **B5.1**, its own hardening slice (D-B5-2); commuting
/ vehicle portal kinds (S1); the `.xlsx` round-trip (B4 later slice); any change to the consultant-side
spend adapter; any new portal principal capability.

## Why this is small

The portal data-entry framework already exists and already contemplates spend:

- `portal_data_entry_bucket_grants.entry_kind` already includes `'spend'` (migration `0029`), and
  `kindMatchesScope` already binds `spend` → scope `3.1` (`portalDataEntry.ts`).
- Draft → submit → `portal_data_entry_review_queue` → staff `decidePortalDataEntryReview` → write to
  `job_scope_rows` is built and tested (`portalDataEntryRecords.ts`, `portalReview` suite).
- The constrained-mirror guardrails (entry window, allowed factors / sites / units, tenant RLS, optimistic
  concurrency, "submitted ≠ reviewed emissions") are built and enforced.

B5 is therefore: **(a)** a spend-shaped capture surface in the portal (mirroring `SpendLedgerAdapter`,
paste + manual only — D-B5-2), **(b)** carrying spend detail + the controlled PG&S category through the
record and the review-queue write so the canonical row lands with parity to B2 (Scope 3.1, **Spend-based**
tier, PG&S category, `SpendDetail` provenance), and **(c)** two additive migrations — per-record spend
detail, and `allowed_pgs_category_ids` on the bucket grant. Everything else is reuse: the monthly split
component and validation come straight from B2 (D-B5-3), the paste parser from B2, the RFC-4180 file parser
is left for B5.1.

## Decided directions (Francis, 31 Aug 2026)

- **D-B5-1 — flag value: `portal-spend`.** Its own gate and its own flip
  (`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend,spend-import,portal-spend`). **Rider:** because the surface is
  client-facing, the **flip** is gated on the full **portal acceptance suite** — cross-client isolation,
  CSRF / same-origin, rate-limiting, stale-session handling, and a rendered a11y pass — not just the
  functional/contract tests. See gate items 1, 5, 8, 10.
- **D-B5-2 — paste + manual for B5; CSV upload is B5.1.** Client file upload is untrusted external input
  and gets its **own hardening slice** (MIME/type + size limits, preflight, injection) that **reuses B4's
  RFC-4180 parser** (`csvReader.ts` / `spendImportMapping.ts`) rather than re-implementing it — with a
  portal-authed preflight route and `client_import_mappings` keyed for the portal principal. B5 ships the
  paste fast path + the single-row manual form only.
- **D-B5-3 — mirror B2's monthly split, made progressive.** Reuse the **same monthly component +
  validation** as B2 (NZC-032 reporting-period-aligned; NZC-035 one framework). In the portal it is
  **progressive disclosure: annual by default, a collapsible monthly expander** — a client is never
  confronted with 12 fields unless they choose to split.
- **D-B5-4 — allowed PG&S categories on the bucket grant.** Add `allowed_pgs_category_ids text[]` to
  `portal_data_entry_bucket_grants` alongside `allowed_factor_ids` / `allowed_site_ids` (migration-owned);
  the client picks **only** from that set. **Factor mapping and sync-to-scope stay staff-side** — the
  client submits a category + net value + (optional) factor from the allowed set; submitted spend routes
  to independent review and **never counts as reviewed emissions**; any AI category suggestion is **bounded
  to the allowed set and advisory only** (NZC-018).

## Pre-flip check (not a build input)

**Are real clients already live on the portal in staging?** As of 31 Aug 2026 — **no** (confirmed). If that
changes before the B5 flip: green the **portal P-track** first, and run a **single pilot client** before a
full flip. Recorded here so the flip PR checks it rather than assuming.

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
- [ ] **Monthly (D-B5-3)** — progressive disclosure: **annual by default**, a collapsible monthly expander
  that reuses B2's monthly component + validation (NZC-032 reporting-period-aligned, calendar-indexed
  storage; annual roll-up derived). A client never sees 12 fields unless they open the expander.
- [ ] **Five explicit states** in the surface: closed/scheduled · window-open-empty · parsing · drafts
  (with advisories) · submitted. A failed load is never rendered as "no entries".
- [ ] Nothing silently dropped from a paste — every input line appears as an editable draft or a clearly
  flagged unparseable line.

### 3. Record model carries spend detail

- [ ] A portal data-entry record of kind `spend` stores: `net_value`, `vat_percent`, `gl_code`,
  `pgs_category_id` (from the allowed list), `invoice_date`, and the monthly vector when the client split it
  — as an additive nullable `detail_json jsonb` (+ a snapshot `entry_kind`) on `portal_data_entry_records`,
  not a widening of the existing scalar columns.
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

### 5. Governed spine unchanged + portal security (D-B5-1 rider)

- [ ] Draft → **client submits** → `portal_data_entry_review_queue` (`pending`) → **staff independent
  review** (`emissions.review`) → accept writes the canonical row / reject returns a mandatory note.
- [ ] No auto-submit, no auto-accept, no second write path. **Factor mapping + sync-to-scope stay
  staff-side** (D-B5-4) — the client submits category + net value + an optional allowed-set factor; the
  staff reviewer owns the canonical write. The client cannot submit outside the window.
- [ ] Delete / edit only an **owned draft**; a submitted record is read-only to the client.
- [ ] Audit events for create / update / submit / delete / review.accept / review.reject, as today, with
  the spend detail in `after_json`.
- [ ] **Cross-client isolation** — a portal user of client A cannot read, create, edit, submit, or void a
  spend record on client B's job, or enumerate B's buckets/categories, under any parameter tampering. New
  two-principal isolation test covering the spend paths.
- [ ] **CSRF / same-origin** — every portal spend write goes through the existing same-origin guard + the
  portal session cookie; a cross-origin POST is rejected.
- [ ] **Rate-limiting** — paste-commit and submit are bounded (a client cannot flood the review queue);
  the cap is explicit and returns a clear message, not a hang.
- [ ] **Stale session** — an expired/revoked portal session mid-entry redirects to `session-ended` and no
  partial write lands (existing `redirectIfPortalSessionEnded`, extended to the spend surface).

### 5a. Flip gate (client-facing — D-B5-1)

The `portal-spend` **flip** does not proceed on the functional/contract suite alone. It additionally
requires: the **portal acceptance suite green** (`test:portal`), the cross-client isolation +
CSRF/origin + rate-limit + stale-session items above verified, and a **rendered a11y + screen-reader
pass** of the live surface on a staging deploy with the flag on.

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

### 8. Flag behaviour (D-B5-1)

- [ ] The flag value **`portal-spend`** is **OFF by default**, resolves identically server- and
  client-side, and gates **only** the portal spend surface. With it off, a `spend`-kind bucket falls back
  to the generic portal manual form (or is hidden — decide in build), and every other portal and console
  surface is unchanged. Removing the value instantly restores the prior behaviour.
- [ ] The flip is a **separate PR** into `render.yaml`, after 5a.

### 9. Tests & build

- [ ] Pure / contract: spend record validation (category in allowed set, VAT range, net ≥ 0, date parse);
  the paste parser reuse; the five-state machine.
- [ ] Backend: a `spend` bucket grant with allowed categories; a spend draft create/update/submit carrying
  `detail_json`; **review accept writes the canonical row with Spend-based tier + PG&S category +
  `SpendDetail` + monthly**; review reject; negatives (category not in allowed set, out-of-window submit,
  stale `expectedSubmittedVersion`, wrong owner, non-3.1 scope row, **cross-client parameter tampering**).
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
   `listPortalDataEntryBuckets`, `decidePortalDataEntryReview` accept-write; backend tests including the
   cross-client isolation cases (gate 5).
3. **Portal surface** — `PortalSpendEntry` (mirror of `SpendLedgerAdapter`, paste + manual) behind the
   flag; wire into `PortalWorkspace` for `spend`-kind buckets; reuse `parseSpendLedger` / `suggestCategory`
   and B2's monthly component (annual-default, collapsible).
4. **Staff UI** — `PortalBucketAdmin` category multi-select for `spend` kind.
5. **e2e + `STAGING_ACCEPTANCE_B5.md`** — automated axe/responsive of the portal spend surface; rate-limit
   + stale-session + CSRF assertions.
6. Separate PR: flip `portal-spend` in `render.yaml` — **after** the flip gate (5a): `test:portal` green,
   portal security items verified, rendered a11y/screen-reader pass on staging with the flag on. If the
   portal has gone client-live by then, pilot one client first.

## B5.1 — portal CSV upload (follow-up, D-B5-2)

Client file upload is untrusted external input and gets its own hardening slice: a portal-authed preflight
route, MIME/type + size + row caps, CSV-injection neutralisation, `client_import_mappings` keyed for the
portal principal — **reusing B4's `csvReader.ts` / `spendImportMapping.ts`**, not re-implementing. Its own
gate section, appended here when B5 lands.

*Prepared 31 Aug 2026; directions confirmed by Francis the same day. Extends the B2/B3/B4 gate line.
Portal is client-not-live in staging (confirmed 31 Aug 2026), so flag flips can be batched — but each
surface still earns its own acceptance record, and this one's flip additionally clears the client-facing
gate 5a.*
