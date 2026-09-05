# LCA/PCF reference module — slice 5: what-if scenarios · acceptance

Track C (job-family modularization, NZC-024). Companion: `docs/MODEL_FIDELITY_JOB_FAMILIES.md` §2,
`docs/ACCEPTANCE_LCA_MODULE_SLICE1.md`…`SLICE4.md`. Flag: **`job-module-lca`** in
`NEXT_PUBLIC_FEATURE_JOB_MODULES` — unchanged, live on staging.

## Scope

What-if scenario modelling — the live `apply_scenario_multipliers` (engine-parity handoff §9): a scenario is
a set of multiplier rules; each rule matches on **module_code / material_category / component** (NULL =
wildcard), a matched line's factor value is scaled by the rule's multiplier (baseline = 1.0, no match), and
the assessment is re-summarised. The comparison view is `module_breakdown` per scenario side by side.
Scenario results are **always computed on demand, never stored** — a what-if is not the reviewed artefact
(that's the result snapshot from L4).

## What's built

- **`packages/contracts/src/jobFamilies.ts`** — `LcaScenario` gains `description` + typed `LcaScenarioMultiplier`
  (with an `id`); new `LcaScenarioWriteFields` / `LcaScenarioMultiplierWriteFields`.
- **`packages/contracts/src/commands.ts`** — `lca.scenario.create` / `.update` / `.delete`,
  `lca.scenario.multiplier.set` (upsert, one rule per module/category/component target) / `.delete`. All
  `emissions.data.edit`. `multiplier ≥ 0`, module code checked, a rule can't target both a category and a
  component.
- **`packages/isolated-backend/src/lcaCalcEngine.ts`** — refactored: `summariseLineEmissions` (a pure
  "per-line kg → summary" function) is now shared by `computeLcaAssessmentResult` (reads stored) and the new
  `computeLcaScenarioResult` (resolves factors fresh with multipliers applied, no writes).
  `scenarioMultiplierFor` picks the most specific matching rule (component > category > module wildcard).
- **`packages/isolated-backend/src/lcaScenarios.ts`** (new) — scenario + multiplier CRUD,
  `listLcaScenariosByAssessments` (batched, attached to the assessment read model), and
  `computeLcaScenarioComparison` (baseline + every scenario, computed on demand).
- **API routes** — `GET/POST .../scenarios`, `PATCH/DELETE .../scenarios/{id}`, `PUT
  .../scenarios/{id}/multipliers`, `DELETE .../scenarios/{id}/multipliers/{id}`, `GET
  .../scenarios/results` (the comparison).
- **`apps/console/app/jobs/lca/LcaWorkspace.tsx`** — a `ScenariosPanel` in the `AssessmentResults` section:
  list scenarios (name, description, rules), add/delete, a per-scenario rule editor (module + optional
  material category + multiplier), and a "Compare scenarios" button that renders the module-breakdown table
  (baseline vs each scenario, with the total-row % delta).
- **`packages/isolated-backend/seeds/0009_synthetic_lca_scenarios.sql`** (new) — a baseline + a "Lightweight
  tray" scenario (×0.85 A1/polymers) on job 714's assessment. Applied to staging, idempotency-verified.
- **e2e** — `tests/e2e/lca-scenarios.spec.ts` (hard-precondition; the flag is live).

## Gate

| # | Item | Check |
|---|---|---|
| 1 | `scenarioMultiplierFor` returns 1.0 with no match; module wildcard < category < component specificity | `lcaScenarios.test.ts` |
| 2 | Scenario CRUD rejects an unknown assessment / scenario and a blank name | `lcaScenarios.test.ts` |
| 3 | `setLcaScenarioMultiplier` upserts one rule per target; rejects a negative multiplier / bad module / category+component both set | `lcaScenarios.test.ts` |
| 4 | `computeLcaScenarioResult` — baseline (no rules) = plain sum; a category rule scales only its lines | `lcaScenarios.test.ts` |
| 5 | `npm run typecheck` (all workspaces) · `@nzi/console` build · full unit suites green | ✅ |

## Verification

- `npm run typecheck` (all workspaces) — clean.
- `npm run test -w @nzi/console` — 121 green.
- `packages/isolated-backend` full suite — 328 green (11 new).
- `npm run build -w @nzi/console` — green, all 5 scenario routes registered.
- No new migration — Phase 0's `0047` already has `lca_scenarios` + `lca_scenario_multipliers`.
- `0009_synthetic_lca_scenarios.sql` applied to isolated staging + re-applied for idempotency.

## Next

**L6 — Charts** (`@nzi/charts` module-breakdown donut/bars, reusing the R1 deterministic print-safe SVG
approach), then **L7 — Report manifest + PCF labelling** (NZC-039 "Product Carbon Footprint" label).
