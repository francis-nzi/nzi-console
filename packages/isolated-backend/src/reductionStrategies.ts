import { randomUUID } from "node:crypto";
import type { Lever, LibraryStrategy, StrategyScope, StrategyControlLevel, StrategyStatus, ClientStrategy, CommandContext, CommandInputMap } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

/**
 * The action-lever library: an Admin-managed catalogue, and the client plans built from it.
 *
 * A catalogue action reads its title, scope and grouping from the lever it points at, so an
 * Admin correcting a lever corrects it everywhere rather than leaving every plan holding a
 * stale copy. A bespoke action carries its own, which is the only reason those columns
 * exist on `client_strategies` at all.
 *
 * Nothing here writes a tCO₂e figure. The plan is qualitative today (A2-lite), and the
 * modelled-impact slot is left empty rather than filled with something plausible.
 */

/* ── Reading ─────────────────────────────────────────────────────────────────────────── */

type StrategyRow = {
  strategy_id: string; strategy_key: string; title: string; description: string; scope: string;
  category: string; control_level: string; icon_key: string; active: boolean; version: number;
  modelled_tco2e_per_year: string | null; modelled_impact_basis: string | null;
  lever_ids: string[] | null;
};

const mapStrategy = (row: StrategyRow): LibraryStrategy => ({
  id: row.strategy_id, key: row.strategy_key, title: row.title, description: row.description,
  scope: row.scope as StrategyScope, category: row.category,
  controlLevel: row.control_level as StrategyControlLevel, iconKey: row.icon_key,
  leverIds: row.lever_ids ?? [],
  active: row.active, version: row.version,
  // The pairing is enforced in the database too; reading it as a tuple means a figure can
  // never reach a screen without the basis that justifies it.
  modelledImpact: row.modelled_tco2e_per_year !== null && row.modelled_impact_basis !== null
    ? { tco2ePerYear: Number(row.modelled_tco2e_per_year), basis: row.modelled_impact_basis }
    : null,
});

// Lever ids are aggregated in the same query rather than fetched per strategy: the plan is
// grouped by lever, so every read needs them, and N+1 round trips to build a grouping is a
// cost paid on every page load.
const STRATEGY_COLUMNS = `s.strategy_id, s.strategy_key, s.title, s.description, s.scope, s.category,
  s.control_level, s.icon_key, s.active, s.version, s.modelled_tco2e_per_year::text, s.modelled_impact_basis,
  coalesce(array_agg(sl.lever_id) FILTER (WHERE sl.lever_id IS NOT NULL), '{}') AS lever_ids`;

/** The levers, in the order Admin set — the plan's grouping follows this. */
export async function listLevers(db: Queryable): Promise<Lever[]> {
  const result = await db.query<{ lever_id: string; lever_key: string; title: string; icon_key: string; ordering: number; active: boolean }>(
    `SELECT lever_id, lever_key, title, icon_key, ordering, active
     FROM nzi_console.levers ORDER BY ordering, lower(title)`);
  return result.rows.map((row) => ({
    id: row.lever_id, key: row.lever_key, title: row.title,
    iconKey: row.icon_key, ordering: row.ordering, active: row.active,
  }));
}

export async function listLibraryStrategies(db: Queryable): Promise<LibraryStrategy[]> {
  const result = await db.query<StrategyRow>(
    `SELECT ${STRATEGY_COLUMNS}
     FROM nzi_console.reduction_strategies s
     LEFT JOIN nzi_console.strategy_levers sl ON (sl.organisation_id, sl.strategy_id) = (s.organisation_id, s.strategy_id)
     GROUP BY s.organisation_id, s.strategy_id
     ORDER BY s.control_level, lower(s.title)`);
  return result.rows.map(mapStrategy);
}

type ClientStrategyRow = {
  client_strategy_id: string; client_id: string; strategy_id: string | null;
  bespoke_title: string | null; bespoke_scope: string | null; bespoke_category: string | null;
  bespoke_control_level: string | null; bespoke_icon_key: string | null;
  status: string; owner: string; target_date: Date | string | null; progress_pct: number;
  notes: string; active: boolean; version: number;
  strategy_title: string | null; strategy_scope: string | null; strategy_category: string | null;
  strategy_control_level: string | null; strategy_icon: string | null;
  lever_ids: string[] | null;
};

const dateOnly = (value: Date | string | null) =>
  value === null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

const mapClientStrategy = (row: ClientStrategyRow): ClientStrategy => ({
  id: row.client_strategy_id, clientId: row.client_id, strategyId: row.strategy_id,
  // The catalogue wins where there is one: a correction there should show here.
  title: row.strategy_title ?? row.bespoke_title ?? "",
  scope: (row.strategy_scope ?? row.bespoke_scope ?? "3") as StrategyScope,
  category: row.strategy_category ?? row.bespoke_category ?? "",
  controlLevel: (row.strategy_control_level ?? row.bespoke_control_level ?? "direct_control") as StrategyControlLevel,
  iconKey: row.strategy_icon ?? row.bespoke_icon_key ?? "target",
  // A library strategy inherits the library's lever allocation; a bespoke one has none yet
  // and falls into the "not allocated" group rather than disappearing from a grouped plan.
  leverIds: row.lever_ids ?? [],
  status: row.status as StrategyStatus, owner: row.owner,
  targetDate: dateOnly(row.target_date), progressPct: row.progress_pct,
  notes: row.notes, active: row.active, version: row.version,
});

export async function listClientStrategies(db: Queryable, clientId: string): Promise<ClientStrategy[]> {
  const result = await db.query<ClientStrategyRow>(
    `SELECT a.client_strategy_id, a.client_id, a.strategy_id, a.bespoke_title, a.bespoke_scope, a.bespoke_category,
            a.bespoke_control_level, a.bespoke_icon_key, a.status, a.owner, a.target_date, a.progress_pct,
            a.notes, a.active, a.version,
            l.title AS strategy_title, l.scope AS strategy_scope, l.category AS strategy_category,
            l.control_level AS strategy_control_level, l.icon_key AS strategy_icon,
            coalesce(array_agg(sl.lever_id) FILTER (WHERE sl.lever_id IS NOT NULL), '{}') AS lever_ids
     FROM nzi_console.client_strategies a
     LEFT JOIN nzi_console.reduction_strategies l ON (l.organisation_id, l.strategy_id) = (a.organisation_id, a.strategy_id)
     LEFT JOIN nzi_console.strategy_levers sl ON (sl.organisation_id, sl.strategy_id) = (l.organisation_id, l.strategy_id)
     WHERE a.client_id = $1
     GROUP BY a.organisation_id, a.client_strategy_id, l.title, l.scope, l.category, l.control_level, l.icon_key
     ORDER BY a.created_at, a.client_strategy_id`, [clientId]);
  return result.rows.map(mapClientStrategy);
}

/* ── The catalogue ───────────────────────────────────────────────────────────────────── */

export type UpsertStrategyResult = { strategyId: string; version: number; created: boolean };

export function upsertLibraryStrategy(pool: PoolLike, input: CommandInputMap["strategy.library.upsert"], context: CommandContext): Promise<StoredOutcome<UpsertStrategyResult>> {
  return runPostgresCommand(pool, "strategy.library.upsert", input, context, async (db) => {
    const key = input.key.trim().toLowerCase();
    const title = input.title.trim();
    const description = input.description?.trim() ?? "";
    const category = input.category?.trim() ?? "";

    if (input.strategyId === undefined) {
      // A key already in use is a collision worth naming rather than silently overwriting
      // whatever is already there — the two levers would be different things.
      const clash = await db.query<{ strategy_id: string }>(
        `SELECT strategy_id FROM nzi_console.reduction_strategies WHERE organisation_id=$1 AND strategy_key=$2`,
        [context.organisationId, key]);
      if (clash.rows[0]) throw new CommandValidationError([{ field: "key", code: "DUPLICATE", message: "A lever with that key already exists." }]);

      const strategyId = `lever-${randomUUID()}`;
      await db.query(
        `INSERT INTO nzi_console.reduction_strategies
           (organisation_id, strategy_id, strategy_key, title, description, scope, category, control_level, icon_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [context.organisationId, strategyId, key, title, description, input.scope, category, input.controlLevel, input.iconKey, context.actorId]);
      const data: UpsertStrategyResult = { strategyId, version: 1, created: true };
      return {
        data,
        entityType: "reduction_strategy", entityId: strategyId, topic: "strategy.library.upserted",
        after: { key, title, scope: input.scope, controlLevel: input.controlLevel },
      };
    }

    const current = await db.query<{ version: number; strategy_key: string; title: string; scope: string; control_level: string }>(
      `SELECT version, strategy_key, title, scope, control_level FROM nzi_console.reduction_strategies
       WHERE organisation_id=$1 AND strategy_id=$2 FOR UPDATE`,
      [context.organisationId, input.strategyId]);
    const strategy = current.rows[0];
    if (!strategy) throw new CommandValidationError([{ field: "strategyId", code: "NOT_FOUND", message: "That strategy is not in the library." }]);
    if (strategy.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion!, strategy.version);

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.reduction_strategies
       SET strategy_key=$3, title=$4, description=$5, scope=$6, category=$7, control_level=$8, icon_key=$9,
           version=version+1, updated_at=now(), updated_by=$10
       WHERE organisation_id=$1 AND strategy_id=$2 RETURNING version`,
      [context.organisationId, input.strategyId, key, title, description, input.scope, category, input.controlLevel, input.iconKey, context.actorId]);
    const data: UpsertStrategyResult = { strategyId: input.strategyId, version: saved.rows[0]!.version, created: false };
    return {
      data,
      entityType: "reduction_strategy", entityId: input.strategyId, topic: "strategy.library.upserted",
      before: { key: strategy.strategy_key, title: strategy.title, scope: strategy.scope, controlLevel: strategy.control_level },
      after: { key, title, scope: input.scope, controlLevel: input.controlLevel },
    };
  });
}

export type DeactivateStrategyResult = { strategyId: string; version: number; heldByClients: number };

/**
 * Withdrawing a lever from the catalogue.
 *
 * It is deactivated, never deleted, and the plans already holding it keep it: a client's
 * plan should not develop a hole because the catalogue moved on. The count of plans still
 * referencing it comes back so the person withdrawing it knows what they have just made
 * un-offerable.
 */
export function deactivateLibraryStrategy(pool: PoolLike, input: CommandInputMap["strategy.library.deactivate"], context: CommandContext): Promise<StoredOutcome<DeactivateStrategyResult>> {
  return runPostgresCommand(pool, "strategy.library.deactivate", input, context, async (db) => {
    const current = await db.query<{ version: number; active: boolean; title: string }>(
      `SELECT version, active, title FROM nzi_console.reduction_strategies
       WHERE organisation_id=$1 AND strategy_id=$2 FOR UPDATE`,
      [context.organisationId, input.strategyId]);
    const strategy = current.rows[0];
    if (!strategy) throw new CommandValidationError([{ field: "strategyId", code: "NOT_FOUND", message: "That strategy is not in the library." }]);
    if (strategy.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, strategy.version);

    const held = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.client_strategies
       WHERE organisation_id=$1 AND strategy_id=$2 AND active`,
      [context.organisationId, input.strategyId]);

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.reduction_strategies SET active=false, version=version+1, updated_at=now(), updated_by=$3
       WHERE organisation_id=$1 AND strategy_id=$2 RETURNING version`,
      [context.organisationId, input.strategyId, context.actorId]);
    return {
      data: { strategyId: input.strategyId, version: saved.rows[0]!.version, heldByClients: Number(held.rows[0]?.count ?? 0) },
      entityType: "reduction_strategy", entityId: input.strategyId, topic: "strategy.library.deactivated",
      before: { active: strategy.active }, after: { active: false, title: strategy.title },
    };
  });
}

/* ── A client's plan ─────────────────────────────────────────────────────────────────── */

export type AssignStrategyResult = { clientStrategyId: string; strategyId: string | null };

export function assignClientStrategy(pool: PoolLike, input: CommandInputMap["client.strategy.assign"], context: CommandContext): Promise<StoredOutcome<AssignStrategyResult>> {
  return runPostgresCommand(pool, "client.strategy.assign", input, context, async (db) => {
    const clientStrategyId = `caction-${randomUUID()}`;
    const targetDate = input.targetDate ?? null;

    if (input.strategyId) {
      const strategy = await db.query<{ active: boolean; title: string }>(
        `SELECT active, title FROM nzi_console.reduction_strategies WHERE organisation_id=$1 AND strategy_id=$2`,
        [context.organisationId, input.strategyId]);
      if (!strategy.rows[0]) throw new CommandValidationError([{ field: "strategyId", code: "NOT_FOUND", message: "That strategy is not in the library." }]);
      // A withdrawn lever stays on the plans that hold it, but is not offered to anyone new.
      if (!strategy.rows[0].active) throw new CommandValidationError([{ field: "strategyId", code: "WITHDRAWN", message: "That strategy has been withdrawn from the library." }]);

      // The unique index enforces this too; catching it here says something useful instead
      // of surfacing a constraint name.
      const held = await db.query<{ client_strategy_id: string }>(
        `SELECT client_strategy_id FROM nzi_console.client_strategies
         WHERE organisation_id=$1 AND client_id=$2 AND strategy_id=$3 AND active`,
        [context.organisationId, input.clientId, input.strategyId]);
      if (held.rows[0]) throw new CommandValidationError([{ field: "strategyId", code: "ALREADY_ASSIGNED", message: "That action is already on this client's plan." }]);

      await db.query(
        `INSERT INTO nzi_console.client_strategies
           (organisation_id, client_strategy_id, client_id, strategy_id, owner, target_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [context.organisationId, clientStrategyId, input.clientId, input.strategyId, input.owner?.trim() ?? "", targetDate, input.notes?.trim() ?? "", context.actorId]);
      const data: AssignStrategyResult = { clientStrategyId, strategyId: input.strategyId };
      return {
        data,
        entityType: "client_strategy", entityId: clientStrategyId, topic: "client.strategy.assigned",
        after: { clientId: input.clientId, strategyId: input.strategyId, title: strategy.rows[0].title },
      };
    }

    const bespoke = input.bespoke!;
    await db.query(
      `INSERT INTO nzi_console.client_strategies
         (organisation_id, client_strategy_id, client_id, bespoke_title, bespoke_scope, bespoke_category,
          bespoke_control_level, bespoke_icon_key, owner, target_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [context.organisationId, clientStrategyId, input.clientId, bespoke.title.trim(), bespoke.scope,
        bespoke.category?.trim() ?? "", bespoke.controlLevel, bespoke.iconKey ?? "target",
        input.owner?.trim() ?? "", targetDate, input.notes?.trim() ?? "", context.actorId]);
    const data: AssignStrategyResult = { clientStrategyId, strategyId: null };
    return {
      data,
      entityType: "client_strategy", entityId: clientStrategyId, topic: "client.strategy.assigned",
      after: { clientId: input.clientId, bespoke: true, title: bespoke.title.trim() },
    };
  });
}

export type UpdateStrategyResult = { clientStrategyId: string; version: number };

export function updateClientStrategy(pool: PoolLike, input: CommandInputMap["client.strategy.update"], context: CommandContext): Promise<StoredOutcome<UpdateStrategyResult>> {
  return runPostgresCommand(pool, "client.strategy.update", input, context, async (db) => {
    const current = await db.query<{ version: number; active: boolean; status: string; progress_pct: number; owner: string; target_date: Date | string | null }>(
      `SELECT version, active, status, progress_pct, owner, target_date FROM nzi_console.client_strategies
       WHERE organisation_id=$1 AND client_strategy_id=$2 FOR UPDATE`,
      [context.organisationId, input.clientStrategyId]);
    const action = current.rows[0];
    if (!action) throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_FOUND", message: "That action does not exist." }]);
    if (action.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, action.version);
    if (!action.active) throw new CommandValidationError([{ field: "clientStrategyId", code: "REMOVED", message: "That action has been removed from the plan." }]);

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.client_strategies
       SET status=$3, owner=$4, target_date=$5, progress_pct=$6, notes=$7,
           version=version+1, updated_at=now(), updated_by=$8
       WHERE organisation_id=$1 AND client_strategy_id=$2 RETURNING version`,
      [context.organisationId, input.clientStrategyId, input.status, input.owner?.trim() ?? "",
        input.targetDate ?? null, input.progressPct, input.notes?.trim() ?? "", context.actorId]);
    return {
      data: { clientStrategyId: input.clientStrategyId, version: saved.rows[0]!.version },
      entityType: "client_strategy", entityId: input.clientStrategyId, topic: "client.strategy.updated",
      before: { status: action.status, progressPct: action.progress_pct, owner: action.owner, targetDate: dateOnly(action.target_date) },
      after: { status: input.status, progressPct: input.progressPct, owner: input.owner?.trim() ?? "", targetDate: input.targetDate ?? null },
    };
  });
}

export type RemoveStrategyResult = { clientStrategyId: string; version: number };

/**
 * Taking an action off the plan.
 *
 * Deactivated, never deleted: what a client once intended to do is part of the history of
 * the engagement, and a published report citing it must not end up pointing at nothing.
 */
export function removeClientStrategy(pool: PoolLike, input: CommandInputMap["client.strategy.remove"], context: CommandContext): Promise<StoredOutcome<RemoveStrategyResult>> {
  return runPostgresCommand(pool, "client.strategy.remove", input, context, async (db) => {
    const current = await db.query<{ version: number; active: boolean }>(
      `SELECT version, active FROM nzi_console.client_strategies
       WHERE organisation_id=$1 AND client_strategy_id=$2 FOR UPDATE`,
      [context.organisationId, input.clientStrategyId]);
    const action = current.rows[0];
    if (!action) throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_FOUND", message: "That action does not exist." }]);
    if (action.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, action.version);

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.client_strategies SET active=false, version=version+1, updated_at=now(), updated_by=$3
       WHERE organisation_id=$1 AND client_strategy_id=$2 RETURNING version`,
      [context.organisationId, input.clientStrategyId, context.actorId]);
    return {
      data: { clientStrategyId: input.clientStrategyId, version: saved.rows[0]!.version },
      entityType: "client_strategy", entityId: input.clientStrategyId, topic: "client.strategy.removed",
      before: { active: action.active }, after: { active: false },
    };
  });
}
