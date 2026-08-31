# B4 — Spend Excel/CSV preflight import: acceptance & flag gate

> **STATUS: directions confirmed by Francis 31 Aug 2026** (answers to Q1–Q6 below, now
> "Decided directions"). Ready to build. Companion to `REDESIGN_ROLLOUT.md` (burndown row B4),
> `DECISIONS.md` NZC-036 (Q3–Q6 to be recorded as sub-notes), and `GAP_ANALYSIS_DATA_ENTRY.md` §2.5 / §5.

**Purpose.** The exit criteria B4 must satisfy. **Scope: the spend template only** — the fourth canonical
download (NZC-036). It adds two of NZC-036's three input methods to the CRM spend adapter: the **Excel
template round-trip** and the **remembered CSV column-mapper**. (The paste-and-validate grid is already
live from B2.) The commuting / vehicle / business-travel templates are **S1**, not B4 — but B4 builds the
**shared preflight/validation engine and the shared download-identity service** that S1 then reuses, so
they cannot diverge.

## What it does

1. **Download** a spend template for a job: one shared filename + a locked, machine-readable **identity
   block** (immutable JobId, period, TemplateVersion, hash).
2. **Upload** the filled template (or the client's own CSV export) → **preflight**: parse, detect
   encoding/delimiter, map columns (remembered per client for CSV), validate every row against the
   embedded identity and the canonical schema, show a **five-state** preview (blockers vs advisories,
   nothing silently dropped).
3. **Commit** → each valid row becomes a `job_emission_sources` spend source exactly as the B2 paste path
   does — Scope 3.1, Spend-based tier, controlled PG&S category, then sync → calculate → **independent
   review**, unchanged.

## Entry (before build)

- B2 + B3 merged, deployed, flag on (`=spend`).
- Directions Q1–Q6 confirmed (below).

---

## Decided directions (Francis, 31 Aug 2026 — NZC-036 sub-notes)

**D1 — parsing library & flow. (revised 31 Aug 2026 — CSV-first)** Parse **in the browser** — the raw
client ledger never reaches the backend (isolation), and preview/mapping are instant. On install,
`exceljs` proved to pull ~98 transitive packages, a transitive moderate `uuid` CVE (not reachable in our
use) and had not been released in ~a year; the console otherwise has **zero non-workspace dependencies**.
**Decision: ship B4 CSV-first with no new dependency.** A real in-browser CSV reader (RFC-4180 quoting,
delimiter + encoding detection, formula-injection neutralisation) covers upload; the template is a plain
`.csv`. The **`.xlsx` round-trip is its own later slice** where the library choice (a maintained SheetJS
release, or a lighter option) gets a focused review. **Flow:** browser parses → preview + column mapping →
sends **normalised `SpendImportRow[]`** to the server → the server issues a context token, preflights
against the job's current state, and writes. **The raw file never touches the backend.**

**D2 — flag.** New value **`spend-import`** (`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend,spend-import`). Its
own acceptance gate, its own flip. B2/B3 stay live on `spend`; B4 bakes independently.

**D3 — import batch & undo.** Additive `import_batch_id` on `job_emission_sources`. Undo is an **audited
soft void** — mark rows `void` + write an audit event, **never a hard delete** (audit history stays
immutable). Undo applies **only** to rows still pending / unsynced / unreviewed — anything reviewed,
synced, or in a frozen snapshot is excluded. Re-import is **idempotent**: the same batch / identity must
not double-insert.

**D4 — remembered mapping.** New **tenant-isolated `client_import_mappings`** table — RLS + migration-owned
(no runtime DDL, same pattern as `client_sites` / `client_factors`). Key `(organisation_id, client_id,
import_kind)` so spend vs commuting maps don't collide; column→field map as `jsonb`; **versioned +
audited**.

**D5 — where identity lives.** **Split.** `@nzi/contracts` owns the identity **shape + encode/decode + the
five preflight states** — one definition shared by the in-browser parser and the server validator, so they
cannot drift. `@nzi/isolated-backend` owns the **server-authoritative** parts: **issuing** the token and
**verifying** it against the job's current version. Contracts *defines*; the backend is the *authority*.

**D6 — how identity travels.** Decide by path, not by comment rows (CSV has no comment standard; Excel
renders `#` rows as data; users break them on save):
  - **CSV and the paste grid are import-only** — job identity comes from **app context** (you are already
    on the job). The route issues a fresh server-signed context token for the current job and preflight
    validates the **content** (period coverage, units, factors). This is the whole of CSV-first B4.
  - **`.xlsx` round-trip (later slice)** — a downloadable/uploadable `.xlsx` would carry identity in
    workbook custom properties or a `veryHidden`, protected sheet; that lands with the library decision.

---

## The gate — all must pass before B4's `spend-import` flag flips

### 1. Identity + template (NZC-036, D5/D6 — CSV-first)

- [ ] **`@nzi/contracts`** owns the identity **shape**, its **encode/decode**, and the **five preflight
  states** — one definition used by both the browser and the server validator. ✅ (increment 1)
- [ ] **`@nzi/isolated-backend`** issues + verifies the signed context token against the job's current
  version (`SPEND_IMPORT_TEMPLATE_VERSION`). ✅ (increment 2)
- [ ] The **CSV template** download — a plain `.csv` with the shared columns (Description · Net value ·
  VAT % · GL code · Invoice date dd/mm/yyyy · PG&S category · Emission factor) and one worked example.
  Filename `{JobNumber}_{ClientName}_{JobName}_{ReportingYear}_Spend.csv`, identifiers sanitised. No
  embedded identity block (CSV takes identity from context, D6).
- [ ] The contracts identity shape + the backend issue/verify are structured so S1's activity-domain
  templates and the `.xlsx` round-trip slice reuse them unchanged.
- [ ] *(later slice)* `.xlsx` round-trip with the identity in a `veryHidden` protected sheet, and the
  reporting-period month columns (NZC-032) in the template.

### 2. Preflight & validation engine (one engine, five states, D6)

- [ ] **CSV / paste-grid** (all of CSV-first B4): import-only; the route issues a fresh server-signed
  **context token** for the current job; `commitSpendImport` verifies it and checks job / period /
  template version (a stale/mismatched job state is a **hard block** with a clear message).
- [ ] **Never** validates by parsing the filename.
- [ ] *(later slice)* `.xlsx` upload also verifies the token **embedded in the file**.
- [ ] Row validation: description present, net value numeric ≥ 0, VAT % in range, invoice date parseable
  (dd/mm/yyyy, NZC-040) and within the reporting period (else advisory), PG&S category resolvable to the
  client's controlled list, factor resolvable in the job's selected datasets.
- [ ] **Five explicit states** (defined in `@nzi/contracts`): empty · parsing · preview (valid +
  advisories) · blocked (identity or schema failure) · committed. Never a partial/degraded state shown
  as success.
- [ ] **Nothing is silently dropped** — every input row appears in the preview as accepted, advisory, or
  blocked, with its row number and reason. Blocked rows do not import; the rest can.
- [ ] Advisories (NZC-018, never block): within-file duplicates (description + net + GL), non-positive
  net, invoice date outside the period, YoY variance vs a rolled-forward prior source (B3), unit sanity.

### 3. Ingestion workflow (governed parity with B2, D1/D4)

- [ ] **In-browser parse** (a real CSV reader in `apps/console/app/jobs/csvReader.ts` — no new
  dependency): file read in the browser → column mapping → **only normalised `SpendImportRow[]`** sent to
  the server. **The raw file never reaches the backend.** ✅ parsers (increment 3a)
- [ ] **CSV round-trip**: download the `.csv` template → fill → upload → preflight → commit. Paste into a
  grid is the fast path (B2 already covers paste for the ledger adapter).
- [ ] **CSV column-mapper**: accept the client's own CSV; auto-map by header, let the consultant re-map;
  the mapping is **remembered per `(client, import_kind)`** in `client_import_mappings` and pre-applied
  next time; the stored map is versioned + audited.
- [ ] Commit creates one `job_emission_sources` spend source per non-blocked row (Scope 3.1, Spend-based
  tier, controlled PG&S category, `SpendDetail`); all rows of a commit share one `import_batch_id`. The
  consultant then syncs + reviews from the register (the B2/B3 spine, unchanged). Blocked rows never
  import; advisories do (NZC-018).

### 4. Governance spine unchanged (D3)

- [ ] Independent review bound to the exact row version; submitted spend **never counts as reviewed
  emissions** until independently reviewed; optimistic concurrency + stale-version recovery; import is
  **never a second write path** and never auto-reviews or auto-syncs.
- [ ] **Undo a batch** is an **audited soft void** — rows are marked `void` and an audit event is
  written; **never a hard delete** (audit history stays immutable). It applies **only** to rows still
  `pending` / unsynced / unreviewed — anything reviewed, synced, or in a frozen snapshot is **excluded**
  from the void with a clear message.
- [ ] **Idempotent re-import**: committing the same batch / identity again does not double-insert
  (matched on `import_batch_id` and/or a content hash surfaced as a "N of these already exist" preview
  note).

### 5. Security & robustness (file upload, D1)

- [ ] **Size cap** and **row cap** (proposed: 5 MB / 10,000 rows) enforced in the browser with a clear
  message, not a hang or a crash.
- [ ] **CSV injection**: any cell beginning `=`, `+`, `-`, `@`, tab or CR is prefixed with `'` on read
  (`neutraliseCell`) so no formula is ever evaluated or round-tripped as live. ✅ (increment 3a)
- [ ] Encoding (BOM) and delimiter (`,` `;` `\t`) are detected; quoted fields with embedded
  newlines/commas/quotes parse correctly (`csvReader.ts`, not `split`). ✅ (increment 3a)
- [ ] *(later slice, with `.xlsx`)* macros never executed; external links / DDE ignored; zip bomb rejected.
- [ ] The server endpoint accepts **only the normalised JSON rows + token** (never a file), behind the
  same-origin guard, staff auth, and tenant scope.

### 6. Isolation & schema

- [ ] Migrations additive, RLS + migration-owned (pattern of `client_sites` / `client_factors`), applied
  to **isolated staging only** before merge; no request-time DDL. Expected:
  - `job_emission_sources.import_batch_id text` (nullable) + a `void` row status (or `voided_at` +
    `voided_by`), additive;
  - `client_import_mappings (organisation_id, client_id, import_kind, mapping_json jsonb, version,
    updated_by, updated_at)` with `FORCE ROW LEVEL SECURITY` and tenant policy.
- [ ] `NEXT_PUBLIC_APP_ENV=staging`; no production credentials or data.

### 7. Flag behaviour (D2)

- [ ] `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` value **`spend-import`**, OFF by default, resolves identically
  server/client. The generic path, the B2 paste path and the B3 rollforward panel are unchanged; removing
  `spend-import` instantly hides the import panel.

### 8. Tests & build

- [ ] Pure (`@nzi/contracts` + console): the CSV reader (quoting, delimiters, encoding, injection cells);
  the identity token encode/decode + hash; the column-mapper resolution; row validation; the five-state
  machine.
- [ ] Backend: token **issue** binds the job's current version; token **verify** rejects wrong-job /
  wrong-period / stale-version; commit creates N sources sharing one `import_batch_id` through the
  unchanged path; **batch soft-void** marks only pending/unsynced/unreviewed rows `void` + audits, and
  refuses (with a clear message) when the batch contains reviewed/synced/snapshot rows; a repeat commit
  of the same batch is a no-op; `client_import_mappings` persists + reloads per `(client, import_kind)`
  and is versioned.
- [ ] Integration journey: issue token → (browser parse) → normalised rows + token → preflight → commit
  → soft-void, including **negatives** (identity mismatch, stale template version, injection payload,
  over-cap file, duplicate re-commit, void of a partially-reviewed batch).
- [ ] `npm run typecheck`, `test:portal`, `test:staff`, contracts + mock-data, `build -w @nzi/console`
  — all green. No new runtime dependency. e2e unaffected with `spend-import` off.

### 9. Accessibility & responsive

- [ ] File input has a real label and a keyboard-operable alternative to any drag-drop; the mapping UI
  is keyboard-navigable with labelled selects; preflight progress and the result summary are announced
  (live region); the blocked-rows list is navigable; visible focus; contrast-safe; reduced-motion.
- [ ] No horizontal overflow at 390 / 768 / 1280 / 1920. Automated axe + responsive in the e2e spec.
- [ ] **Rendered screen-reader pass — human-only**, folded into the #22 / A3 / #25 session.

### 10. Standards

- [ ] "carbon emissions" (NZC-039, not "footprint"); dates dd/mm/yyyy (NZC-040), including in the
  template and the preview.

## Exit

All boxes ticked + `docs/STAGING_ACCEPTANCE_B4.md` (evidence + known limitations + rollback). The
`spend-import` flip is its **own reviewed change** after a rendered acceptance pass — never bundled with
the build.

## Build order

1. ✅ `@nzi/contracts` — identity shape + encode/decode + five-state machine + row validation (PR #29).
2. ✅ `@nzi/isolated-backend` — issue/verify token; `0040` `import_batch_id` migration; `commit` / `void`
   commands (PR #30).
3a. ✅ Console pure — the CSV reader, the column mapper, the CSV template (no dependency; this PR).
3b. Console wiring — `0041 client_import_mappings` migration + read/write; the GET template / POST
   preflight / POST commit / POST void routes; the `SpendImportPanel` behind `spend-import`; e2e
   (axe + responsive); `STAGING_ACCEPTANCE_B4.md`.
4. Separate PR: flip `spend-import` in `render.yaml`.

**Deferred to a later slice:** the `.xlsx` round-trip (with the library decision) and the
reporting-period month columns in the template.

*Prepared 31 Aug 2026; directions confirmed by Francis the same day. Extends the B2/B3 gate line.*
