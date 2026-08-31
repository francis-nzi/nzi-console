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

**D1 — parsing library & flow.** Parse **in the browser** — the raw client ledger never reaches the
backend (isolation), and preview/mapping are instant. Not a bare `npm i xlsx` (the npm SheetJS build,
0.18.5, is stale with known CVEs). Use **`exceljs`** (MIT, on npm, reads **and** writes — D5 needs a
writer; pairs with D6's hidden locked sheet). Load it **dynamically, behind the flag**, so it stays out
of the main bundle. **Flow:** browser parses the file → preview + column mapping → sends **normalised
rows + the identity token** to the server → the server preflights (against the job's current version) and
writes. **The raw file never touches the backend.**

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
  - **`.xlsx` is the round-trip format** — identity in **workbook custom properties or a hidden, locked
    sheet** (final choice made with `exceljs`: a `veryHidden`, protected sheet).
  - **CSV and the paste grid are import-only** — job identity comes from **app context** (you are already
    on the job); preflight validates the **content** (period coverage, units, factors), not a file token.

---

## The gate — all must pass before B4's `spend-import` flag flips

### 1. Canonical download identity (NZC-036, D5/D6)

- [ ] **`@nzi/contracts`** owns the identity **shape**, its **encode/decode**, and the **five preflight
  states** — one definition used by both the browser parser and the server validator.
- [ ] **One shared builder** produces the spend template — filename
  `{JobNumber}_{ClientName}_{JobName}_{ReportingYear}_{Descriptor}.xlsx` with each identifier sanitised of
  `<>:"/\|?*` and collapsed whitespace.
- [ ] The `.xlsx` carries the identity token in a **`veryHidden`, protected worksheet** (via `exceljs`):
  immutable `JobId`, `JobNumber`, `ClientName`, `JobName`, `ReportingYear`, `ReportingPeriodStart/End`,
  `Domain='spend'`, `TemplateVersion`, and an integrity hash. The token is **issued by
  `@nzi/isolated-backend`** against the job's current version.
- [ ] The template's activity columns are the **reporting-period month columns** (NZC-032) plus the
  shared set (Scope · Category/Report Label · ID · UOM · [months] · Qty · Data Source · Notes) and the
  spend-specific columns (PG&S category, net value, VAT %, GL code, invoice date).
- [ ] The builder + identity shape are structured so S1's commuting/vehicle/travel templates reuse them
  unchanged.

### 2. Preflight & validation engine (one engine, five states, D6)

- [ ] **`.xlsx` upload**: the server **verifies the embedded token against the job's current version** —
  wrong job, wrong reporting period, or a stale `TemplateVersion` is a **hard block** with a clear,
  specific message. **Never** validates by parsing the filename.
- [ ] **CSV / paste-grid**: import-only; job identity comes from **app context** (already on the job);
  preflight validates the **content** — period coverage, units, factors — not a file token.
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

- [ ] **In-browser parse** (`exceljs`, loaded dynamically behind the flag): the file is read in the
  browser → preview + column mapping → **only normalised rows + the identity token** are sent to the
  server. **The raw file never reaches the backend.**
- [ ] **Excel round-trip**: download template → fill → upload → preflight → commit.
- [ ] **CSV column-mapper**: accept the client's own CSV; map their headers to the canonical fields; the
  mapping is **remembered per `(client, import_kind)`** in `client_import_mappings` and pre-applied next
  time; the consultant can re-map; the stored map is versioned + audited.
- [ ] Commit creates one `job_emission_sources` spend source per valid row via the **same
  `emission.source.create` + `emission.source.sync`** path as B2 — Scope 3.1, Spend-based tier,
  controlled PG&S category, provenance (ledger source + mapping + factor set/version + data hash +
  as-at), monthly where the template carries it. Every row of a commit shares one `import_batch_id`.

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
- [ ] **CSV injection**: any cell beginning `=`, `+`, `-`, `@`, tab or CR is treated as text on import
  and prefixed/quoted on export — no formula is ever evaluated or round-tripped as live.
- [ ] **`.xlsx`**: macros are never executed; external links / DDE are ignored; a zip bomb / malformed
  archive fails cleanly in the browser parser, not expanded unbounded.
- [ ] File **type is validated by content**, not extension. Encoding (BOM, UTF-8, Latin-1) and delimiter
  (`,` `;` `\t`) are detected; quoted fields with embedded newlines/commas parse correctly (a real CSV
  reader, not `split`).
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
  `spend-import` instantly hides the upload UI (the `exceljs` chunk is not even loaded).

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
  — all green. The `exceljs` chunk is dynamically imported (not in the shared bundle). e2e unaffected
  with `spend-import` off.

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

## Build order (proposed)

1. `@nzi/contracts` — identity shape + encode/decode + hash + five-state machine + row-validation types
   (pure, fully unit-tested). No behaviour change to anything shipped.
2. `@nzi/isolated-backend` — issue/verify the token; `import_batch_id` migration; `client_import_mappings`
   migration + read/write; `emission.source.import.commit` and `emission.source.import.void` commands.
3. Console — the `exceljs` dependency (dynamic import); the browser parser + real CSV reader; the
   template builder (download); the upload → preview → mapping → commit UI behind `spend-import`.
4. e2e spec (axe + responsive of the import panel); `STAGING_ACCEPTANCE_B4.md`.
5. Separate PR: flip `spend-import` in `render.yaml`.

*Prepared 31 Aug 2026; directions confirmed by Francis the same day. Extends the B2/B3 gate line.*
