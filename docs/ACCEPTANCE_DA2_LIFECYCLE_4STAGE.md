# DA2 — four-stage CRP lifecycle · acceptance

Track: **M8 · Data Assurance**. Decision **NZC-057**. **No flag** — the contract stage array plus the
one-way stage migration have no clean seam to gate, so this lands atomically (like DA5). Only the
`job-stage-sections` shell flag is involved, and it is unchanged.

## What changes

- **`packages/contracts/src/commands.ts`** — `jobWorkflowStages.crp` →
  `["Setup", "Data entry", "Review & QA", "Report & publish"]`. "Factor mapping" removed. This drives
  `isAllowedJobStageTransition` (server-side adjacency in `changeJobStage`), `WorkflowStageControl` (the
  global stage rail for **every** CRP job — intended, not a regression) and `CrpStageSections`. **CRP-only**
  — `pcf` keeps its "Factor mapping" stage.
- **Migration `0053_retire_factor_mapping_stage.sql`** — remaps every CRP job currently at the (now invalid)
  "Factor mapping" stage: **→ "Data entry"** if any enabled scope row still lacks a factor, else
  **→ "Review & QA"**. `version` bumped; the remap recorded in `job_stage_history` as
  `from='Factor mapping'`, `to=<new>`, `actor='migration:nzc-057'`, `note='stage retired (NZC-057)'`. Ends
  with a guard that `RAISE`s if any CRP job is still at "Factor mapping". Applied to isolated staging
  **before** this PR's deploy.
- **`apps/console/app/jobs/CrpScopeWorkspace.tsx`** — `stageBody` is now four `<StageSection>`s. The
  Factor-mapping section's content is re-homed:
  - the per-entity source register (`EmissionSourceRegister`, `#emission-source-register`) → into the
    **Data entry** stage (after the accordion + create form);
  - the "without a factor" focus-strip exception → opens **Data entry** with the accordion's
    **Needs-attention** lens (`!row.factorLabel` rows already surface there via `scopeRowNeedsAttention`).
  - The Data-entry stage summary line carries `· N without a factor` when any exist.

## Migration outcome on staging (verified 4 Sep 2026)

| Job | Before | Enabled row lacks a factor? | After | History logged |
|---|---|---|---|---|
| J000712 | Factor mapping | no | Review & QA¹ | ✅ "stage retired (NZC-057)" |
| J000711 | Factor mapping | yes | Data entry | ✅ "stage retired (NZC-057)" |
| J000715 (**pcf**) | Factor mapping | — | **Factor mapping** (untouched) | — |

¹ J000712 (the synthetic demonstrator) was subsequently realigned to "Data entry" via seed `0001` — it had
drifted to "Factor mapping" on staging and the seed's intent is "Data entry". The migration + guard proved
correct on real data; `pcf` untouched confirms the CRP-only scope.

## Gate

| # | Item | Check |
|---|---|---|
| 1 | `jobWorkflowStages.crp` is 4 stages, no "Factor mapping"; `pcf` keeps its "Factor mapping" | `packages/contracts/tests/commands.test.ts` |
| 2 | 4-stage adjacency — `Data entry ↔ Review & QA` allowed; `Data entry → Report & publish` rejected | contracts test |
| 3 | Migration `0053` — remap rule (→ Data entry if unmapped else Review & QA), `version+1`, `job_stage_history` insert with the NZC-057 note, completeness guard | `packages/isolated-backend/tests/migrations.test.ts` |
| 4 | `changeJobStage` — the adjacent transition from Data entry is now Review & QA | `packages/isolated-backend/tests/postgresCommands.test.ts` |
| 5 | Stage shell renders **4** `section.nz-stage-sec`; `#stage-factor-mapping` count 0; Data entry holds `#emission-source-register` | `apps/console/tests/e2e/stage-sections.spec.ts` (hard precondition; runs post-deploy) |
| 6 | `crp-workspace.spec.ts` / `source-register.spec.ts` — "Per-entity register" reachable in Data entry | e2e (post-deploy) |
| 7 | `npm run typecheck` · `@nzi/console` build · full unit suites green | ✅ |
| 8 | Migration applied to isolated staging + verified before merge | ✅ |
| 9 | **Human-only:** the 4-stage rail reads correctly for a job at each stage; a migrated job's history shows the retirement entry | ⏳ Francis |

## Verification (this PR)

- `npm run typecheck` — clean · `npm run build -w @nzi/console` — green.
- `@nzi/contracts` 69/69 (1 new) · `@nzi/isolated-backend` 232/232 (1 new + updated stage test) · console
  85/85 · portal 89/89 · staff 33/33.
- Migration `0053` applied to isolated staging; remap outcome + `job_stage_history` entries verified;
  `pcf` (J000715) confirmed untouched.
- The rendered 4-stage e2e (`stage-sections.spec.ts`, updated in this PR) runs against deployed staging
  after this PR ships — same discipline as UX1e-1.

## Rollback

Not cleanly reversible once jobs are migrated (that's why there is no flag). Reverting the contract to 5
stages would strand every migrated job at an invalid transition set. If needed: revert the contract + a
compensating migration mapping the affected jobs back — but the migration is deliberately one-way.
