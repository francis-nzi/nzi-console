# S2 — Client factors UI: acceptance & flag gate

> **STATUS: directions confirmed by Francis 31 Aug 2026** (D-S2-1..4 below — all four recommendations
> taken). Ready to build. In the pattern of `ACCEPTANCE_B2_SPEND_ADAPTER.md` / `ACCEPTANCE_B4_IMPORT.md` /
> `ACCEPTANCE_B5_PORTAL_SPEND.md`. Companion to `REDESIGN_ROLLOUT.md` (burndown row **S2**), `DECISIONS.md`
> **NZC-041**, and `MODEL_FIDELITY_DATA_ENTRY.md` §2.

**Purpose.** The exit criteria S2 must satisfy. **Scope: the client-factor management surface** — turning
the already-modelled `client_factors` entity (NZC-041, migration `0034`) from *create-only, always-on, no
management* into a **flagged, governed, full-lifecycle** surface: list · view lineage · edit (versioned) ·
archive · reuse on a scope row, with EPD evidence carried into provenance.

**Not in S2:** a real uploaded-file blob store for EPDs (evidence stays a reference + integrity hash — see
D-S2-1); the per-entity source register / commuting / vehicle adapters (that is S1); any change to the
dataset-factor path.

## What already exists (do not rebuild)

- **Schema** — `0034_client_factors.sql`: the `client_factors` table (org + client scoped, optional
  `job_id` pin, `version`, `archived`, evidence columns, `client_factor_evidence_hashed` CHECK), the
  `job_scope_rows` columns `factor_source` / `client_factor_id` / `is_custom_entry` with their presence +
  boundary constraints and triggers. RLS + migration-owned.
- **Create** — `client.factor.create` command + `POST /api/isolated/jobs/{jobId}/client-factors` +
  `ClientFactorPanel` (a create form, **currently rendered unconditionally** in `CrpScopeWorkspace`).
- **Selection** — `listJobFactorOptions` already UNIONs a synthetic "Client factors" dataset
  (`factorSource='client'`, carrying `evidence_hash`), so a client factor is already selectable anywhere a
  factor is (`ScopeRowDrawer`, the spend adapters, the source register).
- **Calculation + lineage** — `syncEmissionSourceToScope` and the scope-row calculate path already read
  `client_factors` (`coalesce(cf.report_label,f.label)`, `coalesce('v'||cf.version, d.version)`), and
  provenance carries `factorSource` + `clientFactorId`.

## What S2 adds

1. A **read model** `listClientFactors(db, clientId, { jobId? })` — reusable + this-job-pinned factors,
   with usage count (how many enabled scope rows reference each), archived flag, evidence descriptor.
2. **`client.factor.update`** — a versioned edit. A change to a **value-bearing field**
   (`kgco2e_per_unit`, `unit`, `ghg_unit`, `geography`, `vintage_year`) **bumps `version`**; existing
   scope rows stay pinned to the `factor_version` they recorded (NZC-030 re-pin discipline) and are
   surfaced with a "factor version moved" advisory (reuse the B3 `factorVersionMoved` pattern). A
   label/description/source edit does not bump the version.
3. **`client.factor.archive`** (and un-archive) — archive is blocked with a clear message while any
   **enabled, non-rejected** scope row still references the factor (the triggers already stop a *new*
   reference to an archived factor; S2 adds the friendly pre-check + the reverse).
4. **The management surface** — replaces the create-only `ClientFactorPanel` with a list + per-row
   view/edit/archive, an evidence descriptor (filename · provider · integrity hash · as-at), and the
   usage count. Behind the flag; the create form folds into it.
5. **Evidence in the drawer** — a scope row whose `factor_source='client'` shows, in the evidence drawer
   lineage, the client factor's label, version, geography, vintage, **and the EPD evidence hash** (the
   value is already in provenance; S2 makes the drawer render it as a distinct lineage step).
6. **Standards** — "carbon emissions" copy; dd/mm/yyyy for the vintage/as-at display.

## Decided directions (Francis, 31 Aug 2026 — all four recommendations taken)

- **D-S2-1 — EPD evidence is a reference + integrity hash.** The schema's `evidence_file_name` /
  `evidence_storage_provider` (`local` | `sharepoint`) / `evidence_url` / `evidence_external_item_id` /
  `evidence_hash` are used as-is: the consultant records where the EPD lives and its SHA-256; the hash
  travels in provenance so lineage is verifiable. The CHECK (filename ⇒ hash) stands. A real in-app
  upload store is a later slice, not S2.
- **D-S2-2 — versioning is mutate-and-bump.** One `client_factors` row per factor. A change to a
  **value-bearing field** (`unit`, `kgco2e_per_unit`, `geography`, `vintage_year`) increments `version`;
  a label / description / source edit does not. Scope rows keep the `factor_version` string they recorded
  and are surfaced with a **`factorVersionMoved`** advisory — identical to B3's dataset-version-moved
  handling (NZC-030). No supersede-with-new-id.
- **D-S2-3 — the primary manage view is client-level** (Clients → a client → "Emission factors"). The
  CRP job keeps a **compact job-scoped panel** — this job's usable factors + quick-add a job-pinned one —
  that links out to the client view.
- **D-S2-4 — flag value `client-factors`** (kebab, matching `spend-import` / `portal-spend`), gating the
  **new management surface**. Today's bare create form stays live and unflagged as the fallback until the
  flip; then the surface replaces it.

---

## The gate — all must pass before S2's flag flips

### 1. Read model & governance

- [ ] `listClientFactors` returns the client's reusable factors + the current job's pinned factors, each
  with: label, scope, category path, unit, `kgco2e_per_unit`, geography, vintage, `version`, source,
  evidence descriptor (filename / provider / hash), `archived`, and **`usageCount`** (enabled scope rows
  referencing it). Tenant-scoped; no cross-client leakage.
- [ ] The surface is **staff-only** behind the existing command permissions
  (`client.factor.create` / `.update` / `.archive` map to a methodology/data-admin-capable permission per
  NZC-022); a read-only staff user sees the list but not the edit controls.

### 2. Create (unchanged) + Update (new, versioned)

- [ ] `client.factor.create` behaviour is unchanged (reusable vs job-pinned; evidence filename ⇒ hash
  required).
- [ ] `client.factor.update` with `expectedVersion` (optimistic concurrency). A change to
  `kgco2e_per_unit` / `unit` / `ghg_unit` / `geography` / `vintage_year` **bumps `version`** and stamps
  `updated_by` / `updated_at`; a change only to `report_label` / `description` / `source` does **not**
  bump `version`.
- [ ] Existing scope rows are **never silently recalculated** — they keep their recorded `factor_version`
  and calculated value until an explicit recalculation, and show a **`factorVersionMoved`** advisory in
  the register + drawer (reuse B3's advisory, never blocking — NZC-018).

### 3. Archive / un-archive

- [ ] `client.factor.archive` is **blocked** with a clear message while any enabled, non-rejected scope
  row references the factor; the message names the count and points to the rows.
- [ ] An archived factor disappears from the selection list (already enforced by
  `listJobFactorOptions` / the triggers) but stays visible in the management list with an "Archived"
  badge and its historical usage.
- [ ] Un-archive restores it to selection. Both transitions are audited.

### 4. Evidence & lineage

- [ ] A scope row with `factor_source='client'`: the evidence drawer shows a distinct lineage step —
  *Client factor · {label} v{version} · {geography} · {vintage} · EPD {hash-prefix} (as at {date})* — and
  the row's `is_custom_entry` badge.
- [ ] Filename without a hash is rejected at the command layer (the CHECK already enforces it at the DB;
  the command returns a friendly issue).
- [ ] The evidence hash is carried into `provenance_json` and into the reviewed snapshot / report
  provenance unchanged.

### 5. Reuse on a scope row

- [ ] From the scope-row drawer, selecting a client factor sets `factorSource='client'`,
  `clientFactorId`, `isCustomEntry=true`, clears `datasetId`/`factorId`, and recalculates on demand
  through the unchanged calculate + independent-review path.
- [ ] The triggers' job/client boundary holds: a job-pinned factor cannot be used on another job; an
  archived factor cannot be newly referenced.

### 6. Isolation & schema

- [ ] **No new migration expected** — `0034` already carries `version` / `archived` / `updated_by` /
  `updated_at` and the evidence columns. If S2 needs one (e.g. a partial index for the archive
  pre-check), it is additive, RLS + migration-owned, applied to isolated staging before merge.
- [ ] `NEXT_PUBLIC_APP_ENV=staging`; synthetic data only.

### 7. Flag behaviour (D-S2-4)

- [ ] `client-factors` value in `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2`, OFF by default, resolves identically
  server/client, gates **only** the management surface. With it off, today's create form still works and
  every other surface is unchanged. Removing the value restores today's behaviour.

### 8. Tests & build

- [ ] Backend: `listClientFactors` (reusable + pinned + usage count + archived); `client.factor.update`
  version bump only on value fields + `expectedVersion` conflict; archive blocked with active references +
  allowed when clear + un-archive; evidence filename ⇒ hash.
- [ ] Read model: register + drawer expose `factorVersionMoved` for a client factor whose version moved.
- [ ] Contract: `client.factor.update` / `.archive` validation.
- [ ] `npm run typecheck`, `test:portal`, `test:staff`, contracts + mock-data, `build -w @nzi/console` —
  all green. No new runtime dependency.

### 9. Accessibility & responsive

- [ ] The management list + edit form: labelled controls, keyboard-operable, status announced, visible
  focus, contrast-safe, no horizontal overflow at 390 / 768 / 1280 / 1920. Automated axe + responsive in
  an e2e spec (skips until the flag is on a staging deploy).
- [ ] **Rendered screen-reader pass — human-only**, folded into the #22 / A3 / #25 session.

### 10. Standards

- [ ] "carbon emissions" (NZC-039); dates dd/mm/yyyy (NZC-040) including the vintage and evidence as-at
  display.

## Exit

All boxes ticked **plus** `docs/STAGING_ACCEPTANCE_S2.md` (evidence + known limitations + rollback). The
flag flip is its **own reviewed change** after a rendered acceptance pass.

## Proposed build order

1. **Docs** — this gate, reviewed and merged (this PR).
2. **Backend** — `listClientFactors` read model; `client.factor.update` + `client.factor.archive`
   commands + routes; backend tests.
3. **Surface** — the flagged management list/edit/archive (client-level view per D-S2-3, plus the compact
   job panel); the drawer evidence lineage step; e2e + `STAGING_ACCEPTANCE_S2.md`.
4. Separate PR: flip `client-factors` in `render.yaml`.

*Prepared 31 Aug 2026. Extends the B/S gate line. Depends only on migration `0034` (already on `main`).*
