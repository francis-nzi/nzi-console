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
