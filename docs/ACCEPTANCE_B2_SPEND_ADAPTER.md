# B2 — Spend Ledger Adapter: acceptance & flag-flip gate

**Purpose.** The exit criteria B2 must satisfy before `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2.spend` is turned
on. This is the Phase 2 exit gate in `REDESIGN_ROLLOUT.md`; written before the build so "done" is defined up
front. Scope: the **CRM/consultant** spend adapter (ledger → mapping → sync-to-scope). The **portal** spend
mirror is B5 — out of scope here except that this model must not preclude it.

## Entry (before build)
- **Phase 0 model merged** (NZC-041–045; migrations 0034–0036 applied on staging): `client_factors`,
  `apply_pct`, the source register, and the new row fields exist on the base branch.
- Built **behind the flag, OFF by default**; the current generic data-entry path stays default and untouched,
  so A-track (A3/A4) acceptance on the current screens stays valid while B2 is developed in parallel.

## The gate — all must pass before flipping the flag

**1. Model correctness**
- [ ] Spend lines **sync to canonical `job_scope_rows`** as Scope 3.1 with the controlled PG&S category
  (NZC-033) and the **Spend-based** quality tier (NZC-010).
- [ ] Every synced row carries **provenance** (ledger source + mapping + factor set/version + data hash +
  as-at date) and expandable **lineage** — no number without its lineage one click away.
- [ ] **Monthly** supported where the ledger carries it — reporting-period-aligned, calendar-indexed storage
  (NZC-032); annual roll-up derived.
- [ ] **Re-sync is idempotent** — stable row identities, no duplicates; mappings are versioned.

**2. Ingestion workflow (governed parity with live)**
- [ ] Upload ledger → preview → commit → per-line **category suggestion (single + bulk)** → consultant
  **confirm/map to factor** → approve → **sync-to-scope**.
- [ ] **Previous-year rollforward** of spend mappings **re-pins prior factor versions** (NZC-030); any moved
  version is flagged for re-review.
- [ ] **Duplicate-key and anomaly** (YoY variance, unit sanity) checks surface as **advisory** flags, not
  hard blocks.

**3. AI categorisation guardrails (NZC-018)**
- [ ] Suggestions grounded in real factors + the client's own prior mappings; show **source + confidence**; a
  human confirms before any number changes; AI is **never a second write path** or a factor of record.

**4. Governance spine unchanged**
- [ ] Independent review bound to the exact row version; **five explicit states** (empty ≠ zero ≠ loading ≠
  failed ≠ success); optimistic concurrency with `expectedVersion` + stale-version recovery; submitted spend
  **never counts as reviewed emissions** until independently reviewed.

**5. Isolation**
- [ ] **Staging only** — no production credentials or data; `NEXT_PUBLIC_APP_ENV=staging`; schema is
  migration-owned (no request-time DDL).

**6. Flag behaviour**
- [ ] Flag **OFF by default**; resolves identically server- and client-side; the current generic path is
  unchanged and still passes its own acceptance; flipping the flag **off instantly restores** the old path.

**7. Tests & build**
- [ ] Contract/unit tests: sync-to-scope, mapping, rollforward re-pin, idempotency.
- [ ] Integration journey: upload → map → sync, including **negatives** (malformed ledger, cross-job/cross-
  version, stale version, duplicate keys).
- [ ] `npm run typecheck`, `npm run test:portal`, `npm run test:staff`, `npm run build -w @nzi/console` — all
  green.

**8. Accessibility & responsive (UI gate — the bar A-track set)**
- [ ] Keyboard operation of the spend grid + mapping + evidence drawer; labelled inputs; status
  announcements; visible focus; reduced-motion; contrast-safe.
- [ ] Responsive at phone / tablet / laptop / wide desktop.
- [ ] **Rendered** screen-reader + viewport review recorded (same standard as A2/A3).

**9. Standards**
- [ ] Copy uses **"carbon emissions"** (NZC-039, footprint reserved for PCF); dates **dd/mm/yyyy** (NZC-040).

**10. Sites / NZC-042**
- [ ] State whether any spend row is **site-attributable**. If yes, **NZC-042** (site-scoped factor
  overrides) must be decided before flipping. If spend is company-level, mark N/A and say so.

## Exit
All boxes ticked **plus** a short `docs/STAGING_ACCEPTANCE_B2.md` record (evidence + known limitations +
rollback check, like M1/M2/M3) → **flip `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2.spend` on.** Do not merge the flip
and the build in one step; the flip is its own reviewed change.

*Prepared 30 Aug 2026. Companion to `REDESIGN_ROLLOUT.md` (Phase 2) and `GAP_ANALYSIS_DATA_ENTRY.md` §2.2 /
§5 (spend).*

---

# B3 — Previous-year rollforward (NZC-030)

**Purpose.** Turn the deferred item **2.2** above into a delivered slice. Same flag (`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend` — no new value), same governance spine, CRM/consultant side only (portal mirror stays B5). Written before the build so "done" is defined up front; this is the B3 exit gate in `REDESIGN_ROLLOUT.md`'s burndown.

**What it does.** From a new reporting year's CRP job, copy last year's **spend mappings** — description → controlled PG&S category → emission factor — forward as fresh, unreviewed spend sources, **re-pinning the exact factor version the prior report used**, and flagging any line whose pinned version has since moved so the consultant re-reviews it before it counts.

**What it deliberately does *not* carry.** Last year's spend *amounts*. Rollforward carries the mapping, not the data; each rolled-forward source lands with **no quantity** and `review_status='pending'` — the consultant enters this year's figures and the row goes through calculate → independent review unchanged.

## Entry (before build)

- B2 flag flipped (`=spend`) and its acceptance record complete.
- Prior-year CRP jobs for the same client exist with `source_type='spend'` sources (the resolver has data to find).

## The gate — all must pass before this slice is "done"

**B3.1 Prior-year resolution**
- [ ] From the target job, resolve the **most recent prior CRP job for the same client** with a lower `reporting_year` that has spend sources. Deterministic; ignores draft/未-published state (mappings, not the published report). No prior job → an explicit **empty state**, never an error or a silent no-op.
- [ ] Optional explicit `fromJobId` override; rejected if it is not a CRP job for the same client with a lower reporting year.

**B3.2 Mapping copy**
- [ ] Each prior spend source copies forward: `source_name`, GL code (`source_subtype`), **controlled PG&S category** (by `category_id` — same client, same controlled list; if the category no longer exists, copy null and flag the line), `SpendDetail` (`vatPercent`, `glCode`, `category` label; `netValue` reset to 0), `scope='3.1'`, `apply_pct`.
- [ ] **Quantity is null**; `data_source` records the origin (`"Rolled forward from J0006xx · FY2025"`); `review_status='pending'`.
- [ ] Provenance/lineage on the eventual synced row names the origin job + reporting year and the re-pinned factor version.

**B3.3 Factor-version re-pin (NZC-030)**
- [ ] The rolled-forward source carries the prior source's **exact** `factor_source` + `dataset_id` + `factor_id` + `client_factor_id` — the same immutable dataset-version row, not the target job's currently-selected version.
- [ ] If that dataset version is not in the target job's `job_dataset_selections`, rollforward adds it as a **`manual`** selection with an audited reason citing the origin job and NZC-030 — so `emission.source.create`/sync validation passes without weakening it.
- [ ] Client factors (`factor_source='client'`) re-pin by `client_factor_id` + the factor's version at that time.

**B3.4 Moved-version flag → re-review**
- [ ] A rolled-forward source whose pinned dataset version is **superseded**, or where the target job selects a different version of the same dataset `name`, is surfaced with a **`factorVersionMoved`** advisory (was `v{old}`, now `v{new}`) in the register and the rollforward preview.
- [ ] The advisory **never blocks** (NZC-018). The re-review is enforced by the unchanged spine: the source is `pending`, its scope row is `pending`, and independent approval is required — the flag just tells the reviewer where to look.

**B3.5 Idempotency & safety**
- [ ] Re-running rollforward **skips** prior sources already rolled forward into this job (matched on `rolled_forward_from_source_id`); no duplicates. Enforced by a partial unique index, not just application logic.
- [ ] Atomic: a failed rollforward leaves no partial sources and no orphan dataset selections.
- [ ] Target-job guard: CRP family only; tenant-scoped; `expectedVersion` not required (append-only, each source independently versioned thereafter).

**B3.6 Governance spine unchanged**
- [ ] Rolled-forward sources are never auto-reviewed or auto-synced. Five explicit states in the preview (empty / loaded / rolling / failed / done). Optimistic concurrency and independent review are exactly B2's.

**B3.7 Isolation & schema**
- [ ] One additive migration only — `0039_emission_source_rollforward_origin.sql`: nullable `rolled_forward_from_source_id` + self-FK + partial unique index. No request-time DDL. Applied to isolated staging before merge.

**B3.8 Tests & build**
- [ ] Contract: `emission.source.rollforward` validation.
- [ ] Backend: copies with pinned `dataset_id`/`factor_id`; adds a superseded dataset to selections with the audited reason; idempotent re-run; non-CRP target rejected; no-prior-job → empty; moved-version flag computed.
- [ ] Read model: rollforward preview (prior job, per-line moved flag, already-rolled-forward), register exposes `rolledForwardFromSourceId` + `factorVersionMoved`.
- [ ] `npm run typecheck`, `test:portal`, `test:staff`, contracts + mock-data, `build -w @nzi/console` — green. e2e unaffected with the grid state unchanged.

**B3.9 Accessibility & responsive**
- [ ] The rollforward preview panel: keyboard-operable, labelled controls, status announced, visible focus, contrast-safe, no horizontal overflow at 390/768/1280/1920. Automated axe + responsive in the e2e spec.
- [ ] **Rendered screen-reader pass — human-only**, folded into the same session as #22 / A3.

**B3.10 Standards**
- [ ] "carbon emissions" (NZC-039); dates dd/mm/yyyy (NZC-040).

## Exit

All boxes ticked + `docs/STAGING_ACCEPTANCE_B3.md` (evidence + known limitations + rollback). No flag change — B3 rides the flag that is already on. PR reviewed and merged separately from any further build.

*B3 section prepared 31 Aug 2026. Extends item 2.2. Burndown row B3 in `REDESIGN_ROLLOUT.md`.*
