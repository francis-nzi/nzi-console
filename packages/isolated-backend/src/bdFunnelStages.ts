import { randomUUID } from "node:crypto";
import {
  bdStageListSpec,
  type BdStageListFilterKey, type BdStageListQuery, type BdStageListSortKey, type CommandContext, type CommandInputMap, type ListPage,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { defineListSql, readListPage } from "./listPage";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * The business-development funnel (admin Phase F2; ruled `phaseF-comms-crm-plan.md`): 0150's `bd_funnel_stages`, added,
 * edited, deactivated and reinstated through the command runner (admin.lookups) — never deleted.
 *
 * - **The key is set once**: a create field only; 0150 grants the role no UPDATE on it.
 * - **Ordered, not defaulted**: the entry stage is the first active by order (`entry` on the list), and the last active
 *   stage cannot be deactivated — the funnel always has a way in.
 * - **A name is unique** per organisation, case-insensitively, inactive included.
 */

const cleanName = (value: string) => value.trim().replace(/\s+/g, " ");
const iso = (date: unknown) => date instanceof Date ? date.toISOString() : String(date);

export type BdStageProvenance = "v7" | "added";
export type BdStageRow = {
  stageId: string; key: string; name: string; sortOrder: number; probabilityPct: number;
  active: boolean; version: number; provenance: BdStageProvenance; updatedAt: string;
  /** The first active stage by order — where a new opportunity starts. */
  entry: boolean;
};
export type BdStagePage = ListPage<BdStageRow, BdStageListFilterKey, Record<string, never>>;

const stageSql = defineListSql<BdStageListSortKey, BdStageListFilterKey>({
  base: `SELECT s.organisation_id, s.stage_id, s.stage_key, s.name, s.sort_order, s.probability_pct::text AS probability, s.active, s.version, s.updated_at,
      CASE WHEN s.active THEN 'active' ELSE 'inactive' END AS status,
      CASE WHEN s.source_system IS NOT NULL THEN 'v7' ELSE 'added' END AS provenance,
      (s.active AND s.stage_id = (SELECT e.stage_id FROM nzi_console.bd_funnel_stages e WHERE e.organisation_id = s.organisation_id AND e.active
                                   ORDER BY e.sort_order, lower(e.name), e.stage_id LIMIT 1)) AS entry
    FROM nzi_console.bd_funnel_stages s`,
  search: ["stage_key", "name"],
  filters: { status: { kind: "equals", column: "status", facet: { noneLabel: "—", values: ["active", "inactive"] } } },
  sort: { sortOrder: { column: "sort_order" }, name: { column: "name", text: true }, probability: { column: "probability_pct" }, status: { column: "status", text: true } },
  tiebreak: "stage_id",
});

export async function listBdStagesPage(db: Queryable, query: BdStageListQuery): Promise<BdStagePage> {
  return readListPage(db, stageSql, bdStageListSpec, query, {
    mapRow: (row) => ({
      stageId: String(row.stage_id), key: String(row.stage_key), name: String(row.name), sortOrder: Number(row.sort_order),
      probabilityPct: Number(row.probability), active: row.active === true, version: Number(row.version),
      provenance: row.provenance as BdStageProvenance, updatedAt: iso(row.updated_at), entry: row.entry === true,
    }),
    mapSummary: () => ({}),
  });
}

// ── Commands (admin.lookups) ─────────────────────────────────────────────────────────────────────────────────────

type Stored = { stage_key: string; name: string; sort_order: number; probability_pct: string; active: boolean; version: number };
type Snapshot = { key: string; name: string; sortOrder: number; probabilityPct: number; active: boolean };
const snapshot = (row: Stored): Snapshot => ({ key: row.stage_key, name: row.name, sortOrder: row.sort_order, probabilityPct: Number(row.probability_pct), active: row.active });
export type BdStageResult = Snapshot & { stageId: string; version: number };
const RETURNING = "RETURNING stage_key, name, sort_order, probability_pct::text, active, version";

async function lock(db: Queryable, context: CommandContext, stageId: string, expectedVersion: number): Promise<Stored> {
  const { rows: [row] } = await db.query<Stored>(
    `SELECT stage_key, name, sort_order, probability_pct::text, active, version FROM nzi_console.bd_funnel_stages WHERE organisation_id = $1 AND stage_id = $2 FOR UPDATE`,
    [context.organisationId, stageId]);
  if (!row) throw new CommandValidationError([{ field: "stageId", code: "NOT_FOUND", message: "That funnel stage is not here." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

async function assertNameFree(db: Queryable, context: CommandContext, name: string, stageId: string | null) {
  const { rows: [taken] } = await db.query<{ taken: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM nzi_console.bd_funnel_stages WHERE organisation_id = $1 AND lower(name) = lower($2) AND stage_id IS DISTINCT FROM $3) AS taken`,
    [context.organisationId, name, stageId]);
  if (taken?.taken) throw new CommandValidationError([{ field: "name", code: "DUPLICATE", message: "Another stage — active or not — already has that name." }]);
}

export function createBdStage(pool: PoolLike, input: CommandInputMap["bd_stage.create"], context: CommandContext): Promise<StoredOutcome<BdStageResult>> {
  return runPostgresCommand(pool, "bd_stage.create", input, context, async (db) => {
    const { rows: [taken] } = await db.query<{ taken: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM nzi_console.bd_funnel_stages WHERE organisation_id = $1 AND stage_key = $2) AS taken`, [context.organisationId, input.stageKey]);
    if (taken?.taken) throw new CommandValidationError([{ field: "stageKey", code: "DUPLICATE", message: "Another stage — active or not — already has that key." }]);
    const name = cleanName(input.name);
    await assertNameFree(db, context, name, null);
    const stageId = `bd-stage:${randomUUID()}`;
    const { rows: [saved] } = await db.query<Stored>(
      `INSERT INTO nzi_console.bd_funnel_stages (organisation_id, stage_id, stage_key, name, sort_order, probability_pct, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ${RETURNING}`,
      [context.organisationId, stageId, input.stageKey, name, input.sortOrder, input.probabilityPct, context.actorId]);
    return { data: { stageId, version: saved!.version, ...snapshot(saved!) }, entityType: "bd_stage", entityId: stageId, topic: "bd_stage.created" };
  });
}

export function updateBdStage(pool: PoolLike, input: CommandInputMap["bd_stage.update"], context: CommandContext): Promise<StoredOutcome<BdStageResult>> {
  return runPostgresCommand(pool, "bd_stage.update", input, context, async (db) => {
    const current = await lock(db, context, input.stageId, input.expectedVersion);
    const name = cleanName(input.name);
    const before = snapshot(current);
    if (name === before.name && input.sortOrder === before.sortOrder && input.probabilityPct === before.probabilityPct) {
      throw new CommandValidationError([{ field: "name", code: "UNCHANGED", message: "That is what the stage already holds." }]);
    }
    await assertNameFree(db, context, name, input.stageId);
    const { rows: [saved] } = await db.query<Stored>(
      `UPDATE nzi_console.bd_funnel_stages SET name = $3, sort_order = $4, probability_pct = $5, version = version + 1, updated_at = now(), updated_by = $6
        WHERE organisation_id = $1 AND stage_id = $2 ${RETURNING}`,
      [context.organisationId, input.stageId, name, input.sortOrder, input.probabilityPct, context.actorId]);
    return { data: { stageId: input.stageId, version: saved!.version, ...snapshot(saved!) }, entityType: "bd_stage", entityId: input.stageId,
      topic: "bd_stage.updated", before };
  });
}

function setActive(key: "bd_stage.deactivate" | "bd_stage.reinstate", active: boolean) {
  return (pool: PoolLike, input: CommandInputMap[typeof key], context: CommandContext): Promise<StoredOutcome<BdStageResult>> =>
    runPostgresCommand(pool, key, input, context, async (db) => {
      const current = await lock(db, context, input.stageId, input.expectedVersion);
      if (current.active === active) throw new CommandValidationError([{ field: "stageId", code: active ? "ALREADY_ACTIVE" : "ALREADY_INACTIVE", message: `That stage is already ${active ? "active" : "inactive"}.` }]);
      if (!active) {
        // The funnel always has a way in: the last active stage stays. Counted under lock, so two deactivations cannot
        // each see the other as the one remaining.
        const { rows: [others] } = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM (SELECT 1 FROM nzi_console.bd_funnel_stages WHERE organisation_id = $1 AND active AND stage_id <> $2 FOR UPDATE) held`,
          [context.organisationId, input.stageId]);
        if ((others?.n ?? 0) === 0) throw new CommandValidationError([{ field: "stageId", code: "LAST_ACTIVE", message: "This is the funnel's only active stage; add or reinstate another before deactivating it." }]);
      }
      const { rows: [saved] } = await db.query<Stored>(
        `UPDATE nzi_console.bd_funnel_stages SET active = $3, version = version + 1, updated_at = now(), updated_by = $4 WHERE organisation_id = $1 AND stage_id = $2 ${RETURNING}`,
        [context.organisationId, input.stageId, active, context.actorId]);
      return { data: { stageId: input.stageId, version: saved!.version, ...snapshot(saved!) }, entityType: "bd_stage", entityId: input.stageId,
        topic: active ? "bd_stage.reinstated" : "bd_stage.deactivated", before: snapshot(current) };
    });
}
export const deactivateBdStage = setActive("bd_stage.deactivate", false);
export const reinstateBdStage = setActive("bd_stage.reinstate", true);
