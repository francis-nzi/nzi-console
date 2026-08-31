# S1 — source register: group roll-up · acceptance record

Running record against `docs/ACCEPTANCE_S1_SOURCE_REGISTER.md`. **Neither domain flag
(`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` values `commuting` / `vehicle`) flips until its gate boxes are ticked
and this record is complete.** Each flip is its own reviewed change; `commuting` and `vehicle` flip
separately.

## Built (increments)

| # | Increment | PR |
|---|-----------|----|
| 1 | **Group roll-up model + backend** — `0043`; `emission.source.group.create` factor; `emission.source.group.sync`; guards; member-change re-aggregation; read-model `rollups[]` | #40 ✅ merged + deployed |
| 2 | **Flagged register UI** — `EmissionSourceRegister`: group factor picker on create; a roll-up group table (member counts, summed total, review status, stale advisory) + "Roll up" button; grouped members show "rolled up via …" and lose the individual Sync button; add path restricted to **Company Vehicle / Employee Commuting** behind `vehicle` / `commuting` (no `asset` add path, NZC-037); with neither flag the register is read-only; `#emission-source-register` e2e | #41 ✅ merged + deployed |
| 1.1 | **Employee Commuting bulk paste** — `commutingBulk.ts` (pure parser + mode matcher + `.csv` template); `CommutingBulkPanel` behind `commuting`: paste → per-row mode + factor → optional roll-up group → import as Scope 3.7 sources sharing one `import_batch_id`; **audited soft-undo** (`emission.source.import.void`, reused); `emission.source.create` gains `importBatchId`; e2e | #42 ✅ merged + deployed |
| 1.2 | **Company Vehicles bulk paste** — `vehicleBulk.ts` (pure parser + fuel matcher + plate normalisation + `.csv` template); `VehicleBulkPanel` behind `vehicle`: paste → per-row fuel + Scope 1/3.6 + factor → optional roll-up group → import as `vehicle` sources sharing one `import_batch_id`; same audited soft-undo; e2e | this PR |
| flips | `commuting`, then `vehicle`, into `render.yaml` | ⏳ |

## S1.2 gate — Company Vehicles bulk paste

Same shape as S1.1 (below), for the `vehicle` domain:

| Item | State |
|---|---|
| Pure parser (`parseVehicleLedger`) — tab / comma / wide-space; header detection; **registration normalised** (upper-case, spaces stripped); free-text fuel → controlled `VEHICLE_FUELS` (`matchFuel`); unit inferred from a `"4200 litres"`-style cell when there's no unit column | ✅ |
| Paste grid — one editable row per line; registration, make/model, controlled fuel select, activity + unit (`litres`/`km`/`mi`/`kWh`/`kg`), **Scope 1 (owned) / Scope 3.6 (grey fleet)** selector, factor from that scope's job factors | ✅ |
| Commit — one `vehicle` `job_emission_sources` per ready row through the unchanged create + sync / roll-up path; ungrouped → per-source sync, grouped → group roll-up (NZC-043); shared `import_batch_id` | ✅ |
| Audited soft-undo — "Undo last import" (`emission.source.import.void`, reused); only pending + unsynced rows, skips synced/reviewed with a count | ✅ |
| `.csv` template download (client-side; no identity block) | ✅ |
| Flag `vehicle` OFF by default; panel absent with it off; register + every other path unchanged | ✅ `dataEntryAdapterEnabled("vehicle")` |
| Tests — `vehicleBulk.test.ts` (parser + fuel matcher + plate normalisation + template); shared backend `importBatchId` + void | ✅ console 42 · isolated-backend 188 · contracts 37 · test:portal 89 · test:staff 31 · `next build` |
| a11y & responsive — automated axe + no-overflow of `#vehicle-bulk` in `vehicle-bulk.spec.ts` (skips until the flag is on staging); human screen-reader pass | ◐ |
| Monthly per line | ⏳ deferred (annual activity only, matches S1.1) |

## S1.1 gate — Employee Commuting bulk paste

| Item | State |
|---|---|
| Pure parser (`parseCommutingLedger`) — tab / comma / wide-space; header detection; free-text mode → controlled `COMMUTE_MODES` (`matchCommuteMode`); miles/km detection; drops blank lines | ✅ |
| Paste grid — one editable row per line; per-row mode select (controlled), distance + unit, WFH days/hours, factor from the job's Scope 3 factors; advisory "Incomplete/Ready" status; nothing dropped | ✅ |
| Commit — one `job_emission_sources` per ready row through the **unchanged** `emission.source.create` + sync/roll-up path (Scope 3.7, `commuting` detail); ungrouped rows sync individually, grouped rows roll the group up (NZC-043) | ✅ |
| Batch id + undo — every row of one import shares an `import_batch_id`; **"Undo last import"** soft-voids (`voided_at`/`voided_by`, `enabled=false`) only rows still pending + unsynced, skipping any already synced/reviewed, with a count — audited, no hard delete | ✅ (reuses the B4 `emission.source.import.void` command) |
| `.csv` template download (client-side; no identity block — CSV is import-only, D6) | ✅ |
| Flag `commuting` OFF by default; panel absent with it off; the register + every other path unchanged | ✅ `dataEntryAdapterEnabled("commuting")` |
| Tests — `commutingBulk.test.ts` (parser + mode matcher + template); backend `importBatchId` on create; contract | ✅ console 35 · isolated-backend 188 · contracts 37 · test:portal 89 · test:staff 31 · `next build` |
| a11y & responsive — automated axe + no-overflow of `#commuting-bulk` in `commuting-bulk.spec.ts` (skips until the flag is on staging); human screen-reader pass with the S1 domains | ◐ |
| Monthly per line | ⏳ deferred — the import path carries the annual distance only (matches B4 spend) |

## Directions — Francis, 31 Aug 2026 (all five confirmed)

Q-S1-1 one aggregated row, members in the register, recompute from ENABLED only, no double count
(cf. `3ed5810e`), provenance→members, not independently editable · Q-S1-2 bulk paste deferred to S1.1/S1.2
· Q-S1-3 vehicle + commuting only in the add UI now (`asset` stays a schema enum, no add path) · Q-S1-4
per-domain flags · Q-S1-5 gate the new capture UI only. **NZC-042 does not gate S1** (`site_id` is a plain
assignment reference here).

## Gate status (after increment 1 — roll-up invariants, gate §2)

| Gate item | State |
|---|---|
| §1 register & group model; kind-specific `detail_json` | ✅ (built pre-S1) — add-path restriction is increment 2 |
| §2 one auto-generated scope row per group (`is_auto_generated`, `group_id`, `auto_pair_kind`) | ✅ `0043` + `emission.source.group.sync` |
| §2 recomputed **deterministically from ENABLED members only** | ✅ `reaggregateGroupRollup` queries `enabled=true` only; a disabled/removed member re-aggregates on next member change |
| §2 **no double-count** — the roll-up row excludes its members | ✅ per-source canonical rows for group members are deleted on every re-aggregate; `emission.source.sync` refuses a grouped source |
| §2 roll-up row **not independently editable** | ✅ `scope.row.update` throws `GROUP_ROLLUP` for a row with `group_id` |
| §2 provenance + lineage back to members; monthly totals reconcile to the member sum | ✅ provenance carries `memberSourceIds` + `enabledMemberCount` + `summedQuantity`; monthly vector is the element-wise member sum (all-or-none monthly); `apply_pct` applied per member, roll-up row `apply_pct=100`; data hash covers the enabled member set |
| §2 member change → review invalidation | ✅ `updateEmissionSourceActivity` / `updateEmissionSourceStatus` re-aggregate the group (→ `review_status='pending'`, `calculated_tco2e=NULL`); read model exposes `stale` |
| §4 governed spine unchanged; optimistic concurrency | ✅ member commands keep `expectedVersion`; the roll-up row goes through calculate + independent review unchanged |
| §5 register UX (one row per group in the scope layer; add path is vehicle/commuting only) | ✅ one row per group; roll-up group table; `Company vehicle` / `Employee commuting` are the only add types (`kindLabel`); `asset` has no add path (NZC-037) |
| §6 isolation & schema — `0043` additive, RLS-covered, migration-owned | ✅ — `0043` applied to isolated staging with #40 |
| §7 flag behaviour — `commuting` / `vehicle` independent, OFF by default | ✅ `dataEntryAdapterEnabled("commuting")` / `("vehicle")` gate the add form + group-create + "Roll up" buttons; with neither on the register is a read-only view of existing sources and every current per-source sync path is unchanged |
| §8 tests | ✅ contract group sync/create validation · backend roll-up (sum, apply_pct, provenance, re-aggregate→pending, mixed-scope reject, no-factor reject, grouped-source-sync refusal, roll-up-edit refusal) · migration invariant · typecheck · contracts 37 · isolated-backend 187 · console 28 · test:portal 89 · test:staff 31 · `next build` |
| §9 a11y & responsive | ◐ automated axe + no-overflow of `#emission-source-register` in `source-register.spec.ts` (skips until a staff account + a domain flag on a staging deploy); **human screen-reader pass per domain** is the open item |
| §10 standards | ✅ "carbon emissions" copy; dates via the shared formatter; month labels via `monthLabel` |

## Remaining before the flips

1. Set `NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2=…,vehicle` (and/or `commuting`) on Render staging (dashboard) →
   the automated `#emission-source-register` scan (gate §9) runs.
2. S1.1 / S1.2 — the bulk paste grids.
3. Gate §9 — human screen-reader pass per domain.
4. Flip PRs — `commuting`, then `vehicle`.

## Rollback

`0043` is additive: `group_id` is nullable and only set by `emission.source.group.sync`. With no flagged
surface calling that command, no roll-up rows are written and every existing per-source sync path is
unchanged. Rolling back = leave `group_id` unused.
