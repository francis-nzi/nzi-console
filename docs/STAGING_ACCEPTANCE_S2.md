# S2 — client factors lifecycle · acceptance record

Running record against `docs/ACCEPTANCE_S2_CLIENT_FACTORS.md`. **The flag
(`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=…,client-factors`) does not flip until every gate box is ticked and
this record is complete.** The flip is its own reviewed change.

## Built (increments)

| # | Increment | PR |
|---|-----------|----|
| 1 | Backend — `listClientFactors` read model (usage count + job-pin filter); `client.factor.update` (versioned — value change bumps `version`, `expectedVersion` concurrency) + `client.factor.archive` / un-archive (blocked while active rows reference it); client-scoped routes; contract + backend tests | this PR |
| 2 | The flagged client-level management surface (list · edit · archive) + the compact CRP job panel + the drawer evidence lineage step; e2e | ⏳ |
| 2.1 | Flip PR — `client-factors` into `render.yaml` | ⏳ |

## Directions — Francis, 31 Aug 2026 (all four recommendations taken)

D-S2-1 evidence = reference + integrity hash · D-S2-2 versioning = mutate-and-bump (value fields only) ·
D-S2-3 manage view at client level + compact job panel · D-S2-4 flag `client-factors`, create form stays
as fallback until the flip. See `DECISIONS.md` NZC-041 (S2 note pending increment 2).

## Gate status (after increment 1)

| # | Gate item | State |
|---|-----------|-------|
| 1 | `listClientFactors` — reusable + job-pinned, usage count, evidence descriptor, archived; tenant-scoped | ✅ backend (surface is increment 2) |
| 2 | `client.factor.update` — `expectedVersion` concurrency; value-field change (`unit` / `kgco2e_per_unit` / `geography` / `vintage_year`) bumps `version`, label/description/source does not; `updated_by`/`updated_at` stamped | ✅ |
| 2 | Existing scope rows never silently recalculated — keep recorded `factor_version`; `factorVersionMoved` advisory | ◐ the advisory is B3's existing register/drawer mechanism for dataset versions; extending it to client-factor version moves is increment 2 |
| 3 | `client.factor.archive` blocked while an enabled, non-rejected scope row references it (message names the count); un-archive unconditional; both audited | ✅ |
| 4 | Evidence & lineage — filename ⇒ hash enforced (command + DB CHECK); hash in `provenance_json` unchanged; a distinct drawer lineage step | ◐ command enforces filename⇒hash; the dedicated drawer lineage step is increment 2 |
| 5 | Reuse on a scope row — selecting a client factor sets `factorSource='client'` etc. through the unchanged calculate + review path | ✅ (already built pre-S2; unchanged) |
| 6 | Isolation & schema — no new migration; `0034` already carries `version`/`archived`/`updated_*` | ✅ no migration |
| 7 | Flag `client-factors` OFF by default | ⏳ increment 2 (flag not yet referenced) |
| 8 | Tests — contract `client.factor.update` / `.archive` validation; backend version-bump-only-on-value-fields + `expectedVersion` conflict + archive blocked/allowed/un-archive + `listClientFactors` shape. typecheck · contracts 36 · isolated-backend 180 · console 28 · test:portal 89 · test:staff 30 · `next build` | ✅ |
| 9 | Accessibility & responsive of the surface | ⏳ increment 2 |
| 10 | "carbon emissions" / dd/mm/yyyy | ⏳ increment 2 (surface copy) |

## Remaining before the flip

1. Increment 2 — the surface, the drawer lineage step, the `factorVersionMoved` extension for client
   factors, e2e.
2. Gate 9 — rendered a11y + human screen-reader pass with `client-factors` on.
3. Flip PR — `client-factors` into `render.yaml`.

## Rollback

Increment 1 is backend-only and inert until a surface calls the new routes. The commands are additive;
`client.factor.create` and every existing path is unchanged. No migration to roll back.
