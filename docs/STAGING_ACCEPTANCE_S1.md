# S1 — source register: group roll-up · acceptance record

Running record against `docs/ACCEPTANCE_S1_SOURCE_REGISTER.md`. **Neither domain flag
(`NEXT_PUBLIC_FEATURE_DATA_ENTRY_V2` values `commuting` / `vehicle`) flips until its gate boxes are ticked
and this record is complete.** Each flip is its own reviewed change; `commuting` and `vehicle` flip
separately.

## Built (increments)

| # | Increment | PR |
|---|-----------|----|
| 1 | **Group roll-up model + backend** — `0043` (`job_scope_rows.group_id` + one-roll-up-per-group index + rollup-shape CHECK); `emission.source.group.create` gains the group's dataset factor; `emission.source.group.sync` recomputes one auto-generated row from **enabled** members; guards (`emission.source.sync` refuses a grouped source; `scope.row.update` refuses a roll-up row); member activity/status changes re-aggregate + re-pend; read model gains `rollups[]` | this PR |
| 2 | Flagged register UI — group factor picker + "Roll up" + exception-first; add UI restricted to **vehicle / commuting** (no `asset` add path, NZC-037); e2e | ⏳ |
| 1.1 / 1.2 | Employee Commuting / Company Vehicles **bulk paste** grids + `.csv` templates (reuse B4 parser) | ⏳ deferred |
| flips | `commuting`, then `vehicle`, into `render.yaml` | ⏳ |

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
| §5 register UX (exception-first, one row per group in the scope layer) | ◐ one row per group ✅; exception-first register view is increment 2 |
| §6 isolation & schema — `0043` additive, RLS-covered (inherits `job_scope_rows` policy), migration-owned | ✅ — **apply `0043` to isolated staging before merge** |
| §7 flag behaviour (per-domain, OFF by default) | ⏳ increment 2 (flags not yet referenced; the model is inert until the group sync is called from a flagged surface) |
| §8 tests | ✅ contract group sync/create validation · backend roll-up (sum, apply_pct, provenance, re-aggregate→pending, mixed-scope reject, no-factor reject, grouped-source-sync refusal, roll-up-edit refusal) · migration invariant · typecheck · contracts 37 · isolated-backend 187 · console 28 · test:portal 89 · test:staff 31 · `next build` |
| §9 a11y & responsive | ⏳ increment 2 |
| §10 standards | ⏳ increment 2 (surface copy) |

## Remaining before the flips

1. Increment 2 — the flagged register UI (group factor picker, "Roll up", exception-first, vehicle/commuting-only add), e2e.
2. S1.1 / S1.2 — the bulk paste grids.
3. Gate §9 — rendered a11y + human screen-reader pass per domain.
4. Flip PRs — `commuting`, then `vehicle`.

## Rollback

`0043` is additive: `group_id` is nullable and only set by `emission.source.group.sync`. With no flagged
surface calling that command, no roll-up rows are written and every existing per-source sync path is
unchanged. Rolling back = leave `group_id` unused.
