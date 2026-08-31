# S2 — client factors lifecycle · acceptance record

Running record against `docs/ACCEPTANCE_S2_CLIENT_FACTORS.md`. **The flag
(`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=…,client-factors`) does not flip until every gate box is ticked and
this record is complete.** The flip is its own reviewed change.

## Built (increments)

| # | Increment | PR |
|---|-----------|----|
| 1 | Backend — `listClientFactors` read model (usage count + job-pin filter); `client.factor.update` (versioned) + `client.factor.archive` / un-archive; client-scoped routes; contract + backend tests | #37 ✅ merged + deployed |
| 2 | `client-factors` flag; `ClientFactorsManager` (list · versioned edit · archive/restore) on the client page + as the compact CRP job panel behind the flag; `clientFactorVersionMoved` on the scope-row read model + a drawer advisory; portal-safe (no portal surface); e2e | this PR |
| 2.1 | Flip PR — `client-factors` into `render.yaml` | ⏳ |

## Directions — Francis, 31 Aug 2026 (all four recommendations taken)

D-S2-1 evidence = reference + integrity hash · D-S2-2 versioning = mutate-and-bump (value fields only) ·
D-S2-3 manage view at client level + compact job panel · D-S2-4 flag `client-factors`, create form stays
as fallback until the flip. See `DECISIONS.md` NZC-041 (S2 note pending increment 2).

## Gate status (after increment 2)

| # | Gate item | State |
|---|-----------|-------|
| 1 | `listClientFactors` — reusable + job-pinned, usage count, evidence descriptor, archived; tenant-scoped. Surface is **staff-only** (client page + job workspace; the commands map to `datasets.override`) | ✅ |
| 2 | `client.factor.update` — `expectedVersion` concurrency; value-field change bumps `version`, label/description/source does not; `updated_by`/`updated_at` stamped. `ClientFactorsManager` inline edit; a version bump shows the "existing rows keep their pinned version" notice | ✅ |
| 2 | Existing scope rows never silently recalculated — keep recorded `factor_version`; **`clientFactorVersionMoved`** on the scope-row read model (SQL: `'v'||cf.version <> factor_version`), surfaced as a non-blocking drawer advisory citing NZC-030 | ✅ |
| 3 | `client.factor.archive` blocked while an enabled, non-rejected scope row references it (message names the count); un-archive unconditional; both audited. Archived rows stay in the manager list with a badge + `usageCount`, `Restore` available | ✅ |
| 4 | Evidence & lineage — filename ⇒ hash (command + DB CHECK); hash in `provenance_json`; the calculate path already writes a "Client factor resolved · {label} · v{version}" lineage step + `evidenceHash` in provenance; the manager shows the evidence descriptor (file · hash prefix · updated date) | ✅ |
| 5 | Reuse on a scope row — selecting a client factor sets `factorSource='client'` etc. through the unchanged calculate + review path | ✅ (built pre-S2; unchanged) |
| 6 | Isolation & schema — no new migration; `0034` already carries `version`/`archived`/`updated_*` | ✅ no migration |
| 7 | Flag `client-factors` OFF by default; with it off the client page shows no factors section and the job panel is exactly today's bare create form | ✅ `dataEntryAdapterEnabled("client-factors")` gates both surfaces |
| 8 | Tests | ✅ contract update/archive validation · backend version-bump/conflict/archive/list + `clientFactorVersionMoved` SQL · typecheck · contracts 36 · isolated-backend 181 · console 28 · test:portal 89 · test:staff 30 · `next build` |
| 9 | Accessibility & responsive of the surface | ◐ automated axe + no-overflow in `client-factors.spec.ts` (skips until a staff account + `client-factors` on a staging deploy); **human screen-reader pass** is the open gate item |
| 10 | "carbon emissions" / dd/mm/yyyy | ✅ manager copy; dates via the shared `formatDate` (dd/mm/yyyy) |

## Remaining before the flip

1. Set `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=…,client-factors` on Render staging (dashboard) → the automated
   `#client-factors-manager` scan (gate 9) runs.
2. Human screen-reader pass with `client-factors` on.
3. Flip PR — `client-factors` into `render.yaml`.

## Known limitations

- **Create stays job-contextual** — a client factor is authored from a job workspace (the compact panel's
  quick-add), because `client.factor.create` resolves the client from the job. The client-level manager
  edits and archives; it links to the job workspace to add. A `clientId`-based create is a later
  convenience, not an S2 gap.

## Rollback

Increment 1 is backend-only and inert until a surface calls the new routes. The commands are additive;
`client.factor.create` and every existing path is unchanged. No migration to roll back.
