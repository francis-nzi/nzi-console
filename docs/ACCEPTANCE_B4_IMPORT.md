# B4 — Spend Excel/CSV preflight import: acceptance & flag gate

> **STATUS: DRAFT for Francis.** Written before the build so "done" is defined up front, like
> `ACCEPTANCE_B2_SPEND_ADAPTER.md` and its B3 section. **The "Design questions" section below needs your
> answers before implementation starts.** Companion to `REDESIGN_ROLLOUT.md` (burndown row B4),
> `DECISIONS.md` NZC-036, and `GAP_ANALYSIS_DATA_ENTRY.md` §2.5 / §5.

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
- The "Design questions" section below is answered.
- No new external dependency is added without sign-off (see Q1).

---

## Design questions — decide before build

**Q1 — `.xlsx` parsing.** The console has **zero parsing dependencies** today. CSV is trivial (extend the
B2 parser with a proper quoted-field reader). `.xlsx` is a zipped XML workbook and needs a library
(`xlsx` / SheetJS, or `exceljs`). Options:
  - **(a) CSV-only for B4**, `.xlsx` deferred to S1 — no new dependency, ships faster, but the client
    downloads an `.xlsx` template and can't upload it back as `.xlsx` (they'd "Save As CSV").
  - **(b) Add `xlsx` (SheetJS)** — full round-trip, ~1 dependency, parse in the browser (no server
    memory), well-audited. **Recommended** given NZC-036 says "hardened Excel round-trip … as the offline
    baseline".
  - (c) Server-side parse with `exceljs` — streaming, but adds a server dependency and a memory/timeout
    surface.

**Q2 — flag value.** B2/B3 ride `=spend`, already flipped — so anything merged under `spend` is live
immediately. B4 adds a **file-upload attack surface**. Options:
  - **(a) New value `spend-import`** (`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=spend,spend-import`) — B4 gets
    its own rendered-acceptance-gated flip, consistent with the strangler pattern. **Recommended.**
  - (b) Fold into `spend` — no separate flip; B4 goes live on merge. Faster, less ceremony, but couples
    the security review to a normal PR merge.

**Q3 — import batch / undo.** A 200-row import that's wrong is painful to unpick one source at a time.
  - **(a) Add `import_batch_id` (nullable) to `job_emission_sources`** (migration, additive) + an
    `emission.source.import.undo` command that archives a whole batch **only while every row in it is
    still `pending` and unsynced** (never touches reviewed evidence). **Recommended** — cheap, matches
    the live system's spend workflow.
  - (b) No batch concept — rely on per-source archive.

**Q4 — remembered CSV mapping storage.** NZC-036 says "remember the mapping **per client**". That needs
server-side persistence.
  - **(a) New table `client_import_mappings`** `(organisation_id, client_id, domain, mapping_json,
    updated_by, updated_at)` (migration) — one remembered column map per client per domain. **Recommended.**
  - (b) Job-scoped only (no cross-year memory) — simpler, loses the NZC-036 "one click next year" benefit.

**Q5 — download-identity service home.** The shared builder (filename + identity block) is used by B4 now
and S1 later. Build it as `@nzi/isolated-backend` (`downloadIdentity.ts`) producing the identity block +
sanitised filename, with the workbook assembly in the console? Confirm the package boundary.

**Q6 — template format for the identity block.** In a CSV there is no "locked header block". Proposal:
CSV uploads carry identity as the **first N commented/reserved rows** (`# nzi:jobId=…`) that preflight
reads and strips; `.xlsx` uses a hidden/locked sheet. Confirm acceptable, or require `.xlsx` for the
round-trip and treat CSV strictly as the client-native mapper path (identity supplied by the UI, not the
file).

---

## The gate — all must pass before B4's flag flips (or before merge, if Q2 = fold-in)

### 1. Canonical download identity (NZC-036)

- [ ] **One shared builder** produces every spend template/export — filename
  `{JobNumber}_{ClientName}_{JobName}_{ReportingYear}_{Descriptor}` with each identifier sanitised of
  `<>:"/\|?*` and collapsed whitespace.
- [ ] A **machine-readable identity block** carries immutable `JobId`, `JobNumber`, `ClientName`,
  `JobName`, `ReportingYear`, `ReportingPeriodStart/End`, `Domain='spend'`, `TemplateVersion`, and an
  integrity hash.
- [ ] The template's activity columns are the **reporting-period month columns** (NZC-032) plus the
  shared set (Scope · Category/Report Label · ID · UOM · [months] · Qty · Data Source · Notes) and the
  spend-specific columns (PG&S category, net value, VAT %, GL code, invoice date).
- [ ] The builder is structured so S1's commuting/vehicle/travel templates reuse it unchanged.

### 2. Preflight & validation engine (one engine, five states)

- [ ] Preflight validates the upload against the **embedded identity** — wrong job, wrong reporting
  period, or a stale `TemplateVersion` is a **hard block** with a clear, specific message. **Never**
  validates by parsing the filename.
- [ ] Row validation: description present, net value numeric ≥ 0, VAT % in range, invoice date parseable
  (dd/mm/yyyy, NZC-040) and within the reporting period (else advisory), PG&S category resolvable to the
  client's controlled list, factor resolvable in the job's selected datasets.
- [ ] **Five explicit states**: empty · parsing · preview (valid + advisories) · blocked (identity or
  schema failure) · committed. Never a partial/degraded state shown as success.
- [ ] **Nothing is silently dropped** — every input row appears in the preview as accepted, advisory, or
  blocked, with its row number and reason. Blocked rows do not import; the rest can.
- [ ] Advisories (NZC-018, never block): within-file duplicates (description + net + GL), non-positive
  net, invoice date outside the period, YoY variance vs a rolled-forward prior source (B3), unit sanity.

### 3. Ingestion workflow (governed parity with B2)

- [ ] **Excel round-trip**: download template → fill → upload → preflight → commit.
- [ ] **CSV column-mapper**: accept the client's own CSV; map their headers to the canonical fields;
  **the mapping is remembered per client** and pre-applied next time; the consultant can re-map.
- [ ] Commit creates one `job_emission_sources` spend source per valid row via the **same
  `emission.source.create` + `emission.source.sync`** path as B2 — Scope 3.1, Spend-based tier,
  controlled PG&S category, provenance (ledger source + mapping + factor set/version + data hash +
  as-at), monthly where the template carries it.
- [ ] Re-uploading the same file does not double-import (Q3 batch, or the B2 within-file duplicate
  advisory plus a clear "N of these already exist" preview note).

### 4. Governance spine unchanged

- [ ] Independent review bound to the exact row version; submitted spend **never counts as reviewed
  emissions** until independently reviewed; optimistic concurrency + stale-version recovery; import is
  **never a second write path** and never auto-reviews or auto-syncs.
- [ ] If Q3 = batch undo: undo only archives rows that are still `pending` and unsynced; it never touches
  a calculated or reviewed row, and it is audited.

### 5. Security & robustness (file upload)

- [ ] **Size cap** and **row cap** (proposed: 5 MB / 10,000 rows) enforced with a clear message, not a
  hang or a crash.
- [ ] **CSV injection**: any cell beginning `=`, `+`, `-`, `@`, tab or CR is treated as text on import
  and prefixed/quoted on export — no formula is ever evaluated or round-tripped as live.
- [ ] **`.xlsx`**: macros are never executed; external links/DDE are ignored; a zip bomb / malformed
  archive is rejected, not expanded unbounded.
- [ ] File **type is validated by content**, not extension. Encoding (BOM, UTF-8, Latin-1) and delimiter
  (`,` `;` `\t`) are detected; quoted fields with embedded newlines/commas parse correctly (a real CSV
  reader, not `split`).
- [ ] Upload endpoint enforces the same-origin guard, staff auth, and tenant scope; the file is parsed
  in memory and discarded — **not persisted** (unless Q3 batch keeps a hash for dedup).

### 6. Isolation & schema

- [ ] Migrations are additive and applied to **isolated staging only** before merge; no request-time
  DDL. (Expected: `import_batch_id` column and/or `client_import_mappings` table, per Q3/Q4.)
- [ ] `NEXT_PUBLIC_APP_ENV=staging`; no production credentials or data.

### 7. Flag behaviour

- [ ] Per Q2. If a new value: OFF by default, resolves identically server/client, generic path and the
  B2 paste path unchanged, flag-off instantly hides the upload UI.

### 8. Tests & build

- [ ] Pure: the CSV reader (quoting, delimiters, encoding, injection cells); the identity-block
  builder/parser; the column-mapper resolution; row validation.
- [ ] Backend: preflight rejects a wrong-job / wrong-period / stale-version file; commit creates N
  sources through the unchanged path; batch undo (if Q3) only archives pending rows; mapping is
  persisted and reloaded per client.
- [ ] Integration journey: download → upload → preflight → commit, including **negatives** (identity
  mismatch, malformed workbook, injection payload, over-cap file, duplicate re-upload).
- [ ] `npm run typecheck`, `test:portal`, `test:staff`, contracts + mock-data, `build -w @nzi/console`
  — all green. e2e unaffected with the upload UI hidden.

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

All boxes ticked + `docs/STAGING_ACCEPTANCE_B4.md` (evidence + known limitations + rollback). If Q2 = new
flag value: the flip is its own reviewed change after a rendered acceptance pass, never bundled with the
build. If Q2 = fold-in: the security review (§5) is called out explicitly in the build PR.

*Draft prepared 31 Aug 2026 for Francis's review. Extends the B2/B3 gate line.*
