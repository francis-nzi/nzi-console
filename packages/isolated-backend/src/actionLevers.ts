import { randomUUID } from "node:crypto";
import type { ActionLever, ActionScope, ActionControlLevel, ActionStatus, ClientAction, CommandContext, CommandInputMap } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

/**
 * The action-lever library: an Admin-managed catalogue, and the client plans built from it.
 *
 * A catalogue action reads its title, scope and grouping from the lever it points at, so an
 * Admin correcting a lever corrects it everywhere rather than leaving every plan holding a
 * stale copy. A bespoke action carries its own, which is the only reason those columns
 * exist on `client_actions` at all.
 *
 * Nothing here writes a tCO₂e figure. The plan is qualitative today (A2-lite), and the
 * modelled-impact slot is left empty rather than filled with something plausible.
 */

/* ── Reading ─────────────────────────────────────────────────────────────────────────── */

type LeverRow = {
  lever_id: string; lever_key: string; title: string; description: string; scope: string;
  category: string; control_level: string; icon_key: string; active: boolean; version: number;
  modelled_tco2e_per_year: string | null; modelled_impact_basis: string | null;
};

const mapLever = (row: LeverRow): ActionLever => ({
  id: row.lever_id, key: row.lever_key, title: row.title, description: row.description,
  scope: row.scope as ActionScope, category: row.category,
  controlLevel: row.control_level as ActionControlLevel, iconKey: row.icon_key,
  active: row.active, version: row.version,
  // The pairing is enforced in the database too; reading it as a tuple means a figure can
  // never reach a screen without the basis that justifies it.
  modelledImpact: row.modelled_tco2e_per_year !== null && row.modelled_impact_basis !== null
    ? { tco2ePerYear: Number(row.modelled_tco2e_per_year), basis: row.modelled_impact_basis }
    : null,
});

const LEVER_COLUMNS = `lever_id, lever_key, title, description, scope, category, control_level, icon_key,
  active, version, modelled_tco2e_per_year::text, modelled_impact_basis`;

export async function listActionLevers(db: Queryable): Promise<ActionLever[]> {
  const result = await db.query<LeverRow>(
    `SELECT ${LEVER_COLUMNS} FROM nzi_console.action_levers ORDER BY control_level, lower(title)`);
  return result.rows.map(mapLever);
}

type ActionRow = {
  client_action_id: string; client_id: string; lever_id: string | null;
  bespoke_title: string | null; bespoke_scope: string | null; bespoke_category: string | null;
  bespoke_control_level: string | null; bespoke_icon_key: string | null;
  status: string; owner: string; target_date: Date | string | null; progress_pct: number;
  notes: string; active: boolean; version: number;
  lever_title: string | null; lever_scope: string | null; lever_category: string | null;
  lever_control_level: string | null; lever_icon: string | null;
};

const dateOnly = (value: Date | string | null) =>
  value === null ? null : value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);

const mapAction = (row: ActionRow): ClientAction => ({
  id: row.client_action_id, clientId: row.client_id, leverId: row.lever_id,
  // The catalogue wins where there is one: a correction there should show here.
  title: row.lever_title ?? row.bespoke_title ?? "",
  scope: (row.lever_scope ?? row.bespoke_scope ?? "3") as ActionScope,
  category: row.lever_category ?? row.bespoke_category ?? "",
  controlLevel: (row.lever_control_level ?? row.bespoke_control_level ?? "direct_control") as ActionControlLevel,
  iconKey: row.lever_icon ?? row.bespoke_icon_key ?? "target",
  status: row.status as ActionStatus, owner: row.owner,
  targetDate: dateOnly(row.target_date), progressPct: row.progress_pct,
  notes: row.notes, active: row.active, version: row.version,
});

export async function listClientActions(db: Queryable, clientId: string): Promise<ClientAction[]> {
  const result = await db.query<ActionRow>(
    `SELECT a.client_action_id, a.client_id, a.lever_id, a.bespoke_title, a.bespoke_scope, a.bespoke_category,
            a.bespoke_control_level, a.bespoke_icon_key, a.status, a.owner, a.target_date, a.progress_pct,
            a.notes, a.active, a.version,
            l.title AS lever_title, l.scope AS lever_scope, l.category AS lever_category,
            l.control_level AS lever_control_level, l.icon_key AS lever_icon
     FROM nzi_console.client_actions a
     LEFT JOIN nzi_console.action_levers l ON (l.organisation_id, l.lever_id) = (a.organisation_id, a.lever_id)
     WHERE a.client_id = $1
     ORDER BY a.created_at, a.client_action_id`, [clientId]);
  return result.rows.map(mapAction);
}

/* ── The catalogue ───────────────────────────────────────────────────────────────────── */

export type UpsertLeverResult = { leverId: string; version: number; created: boolean };

export function upsertActionLever(pool: PoolLike, input: CommandInputMap["action.lever.upsert"], context: CommandContext): Promise<StoredOutcome<UpsertLeverResult>> {
  return runPostgresCommand(pool, "action.lever.upsert", input, context, async (db) => {
    const key = input.key.trim().toLowerCase();
    const title = input.title.trim();
    const description = input.description?.trim() ?? "";
    const category = input.category?.trim() ?? "";

    if (input.leverId === undefined) {
      // A key already in use is a collision worth naming rather than silently overwriting
      // whatever is already there — the two levers would be different things.
      const clash = await db.query<{ lever_id: string }>(
        `SELECT lever_id FROM nzi_console.action_levers WHERE organisation_id=$1 AND lever_key=$2`,
        [context.organisationId, key]);
      if (clash.rows[0]) throw new CommandValidationError([{ field: "key", code: "DUPLICATE", message: "A lever with that key already exists." }]);

      const leverId = `lever-${randomUUID()}`;
      await db.query(
        `INSERT INTO nzi_console.action_levers
           (organisation_id, lever_id, lever_key, title, description, scope, category, control_level, icon_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [context.organisationId, leverId, key, title, description, input.scope, category, input.controlLevel, input.iconKey, context.actorId]);
      const data: UpsertLeverResult = { leverId, version: 1, created: true };
      return {
        data,
        entityType: "action_lever", entityId: leverId, topic: "action.lever.upserted",
        after: { key, title, scope: input.scope, controlLevel: input.controlLevel },
      };
    }

    const current = await db.query<{ version: number; lever_key: string; title: string; scope: string; control_level: string }>(
      `SELECT version, lever_key, title, scope, control_level FROM nzi_console.action_levers
       WHERE organisation_id=$1 AND lever_id=$2 FOR UPDATE`,
      [context.organisationId, input.leverId]);
    const lever = current.rows[0];
    if (!lever) throw new CommandValidationError([{ field: "leverId", code: "NOT_FOUND", message: "That lever does not exist." }]);
    if (lever.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion!, lever.version);

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.action_levers
       SET lever_key=$3, title=$4, description=$5, scope=$6, category=$7, control_level=$8, icon_key=$9,
           version=version+1, updated_at=now(), updated_by=$10
       WHERE organisation_id=$1 AND lever_id=$2 RETURNING version`,
      [context.organisationId, input.leverId, key, title, description, input.scope, category, input.controlLevel, input.iconKey, context.actorId]);
    const data: UpsertLeverResult = { leverId: input.leverId, version: saved.rows[0]!.version, created: false };
    return {
      data,
      entityType: "action_lever", entityId: input.leverId, topic: "action.lever.upserted",
      before: { key: lever.lever_key, title: lever.title, scope: lever.scope, controlLevel: lever.control_level },
      after: { key, title, scope: input.scope, controlLevel: input.controlLevel },
    };
  });
}

export type DeactivateLeverResult = { leverId: string; version: number; heldByClients: number };

/**
 * Withdrawing a lever from the catalogue.
 *
 * It is deactivated, never deleted, and the plans already holding it keep it: a client's
 * plan should not develop a hole because the catalogue moved on. The count of plans still
 * referencing it comes back so the person withdrawing it knows what they have just made
 * un-offerable.
 */
export function deactivateActionLever(pool: PoolLike, input: CommandInputMap["action.lever.deactivate"], context: CommandContext): Promise<StoredOutcome<DeactivateLeverResult>> {
  return runPostgresCommand(pool, "action.lever.deactivate", input, context, async (db) => {
    const current = await db.query<{ version: number; active: boolean; title: string }>(
      `SELECT version, active, title FROM nzi_console.action_levers
       WHERE organisation_id=$1 AND lever_id=$2 FOR UPDATE`,
      [context.organisationId, input.leverId]);
    const lever = current.rows[0];
    if (!lever) throw new CommandValidationError([{ field: "leverId", code: "NOT_FOUND", message: "That lever does not exist." }]);
    if (lever.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, lever.version);

    const held = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.client_actions
       WHERE organisation_id=$1 AND lever_id=$2 AND active`,
      [context.organisationId, input.leverId]);

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.action_levers SET active=false, version=version+1, updated_at=now(), updated_by=$3
       WHERE organisation_id=$1 AND lever_id=$2 RETURNING version`,
      [context.organisationId, input.leverId, context.actorId]);
    return {
      data: { leverId: input.leverId, version: saved.rows[0]!.version, heldByClients: Number(held.rows[0]?.count ?? 0) },
      entityType: "action_lever", entityId: input.leverId, topic: "action.lever.deactivated",
      before: { active: lever.active }, after: { active: false, title: lever.title },
    };
  });
}

/* ── A client's plan ─────────────────────────────────────────────────────────────────── */

export type AssignActionResult = { clientActionId: string; leverId: string | null };

export function assignClientAction(pool: PoolLike, input: CommandInputMap["client.action.assign"], context: CommandContext): Promise<StoredOutcome<AssignActionResult>> {
  return runPostgresCommand(pool, "client.action.assign", input, context, async (db) => {
    const clientActionId = `caction-${randomUUID()}`;
    const targetDate = input.targetDate ?? null;

    if (input.leverId) {
      const lever = await db.query<{ active: boolean; title: string }>(
        `SELECT active, title FROM nzi_console.action_levers WHERE organisation_id=$1 AND lever_id=$2`,
        [context.organisationId, input.leverId]);
      if (!lever.rows[0]) throw new CommandValidationError([{ field: "leverId", code: "NOT_FOUND", message: "That lever is not in the catalogue." }]);
      // A withdrawn lever stays on the plans that hold it, but is not offered to anyone new.
      if (!lever.rows[0].active) throw new CommandValidationError([{ field: "leverId", code: "WITHDRAWN", message: "That lever has been withdrawn from the catalogue." }]);

      // The unique index enforces this too; catching it here says something useful instead
      // of surfacing a constraint name.
      const held = await db.query<{ client_action_id: string }>(
        `SELECT client_action_id FROM nzi_console.client_actions
         WHERE organisation_id=$1 AND client_id=$2 AND lever_id=$3 AND active`,
        [context.organisationId, input.clientId, input.leverId]);
      if (held.rows[0]) throw new CommandValidationError([{ field: "leverId", code: "ALREADY_ASSIGNED", message: "That action is already on this client's plan." }]);

      await db.query(
        `INSERT INTO nzi_console.client_actions
           (organisation_id, client_action_id, client_id, lever_id, owner, target_date, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [context.organisationId, clientActionId, input.clientId, input.leverId, input.owner?.trim() ?? "", targetDate, input.notes?.trim() ?? "", context.actorId]);
      const data: AssignActionResult = { clientActionId, leverId: input.leverId };
      return {
        data,
        entityType: "client_action", entityId: clientActionId, topic: "client.action.assigned",
        after: { clientId: input.clientId, leverId: input.leverId, title: lever.rows[0].title },
      };
    }

    const bespoke = input.bespoke!;
    await db.query(
      `INSERT INTO nzi_console.client_actions
         (organisation_id, client_action_id, client_id, bespoke_title, bespoke_scope, bespoke_category,
          bespoke_control_level, bespoke_icon_key, owner, target_date, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [context.organisationId, clientActionId, input.clientId, bespoke.title.trim(), bespoke.scope,
        bespoke.category?.trim() ?? "", bespoke.controlLevel, bespoke.iconKey ?? "target",
        input.owner?.trim() ?? "", targetDate, input.notes?.trim() ?? "", context.actorId]);
    const data: AssignActionResult = { clientActionId, leverId: null };
    return {
      data,
      entityType: "client_action", entityId: clientActionId, topic: "client.action.assigned",
      after: { clientId: input.clientId, bespoke: true, title: bespoke.title.trim() },
    };
  });
}

export type UpdateActionResult = { clientActionId: string; version: number };

export function updateClientAction(pool: PoolLike, input: CommandInputMap["client.action.update"], context: CommandContext): Promise<StoredOutcome<UpdateActionResult>> {
  return runPostgresCommand(pool, "client.action.update", input, context, async (db) => {
    const current = await db.query<{ version: number; active: boolean; status: string; progress_pct: number; owner: string; target_date: Date | string | null }>(
      `SELECT version, active, status, progress_pct, owner, target_date FROM nzi_console.client_actions
       WHERE organisation_id=$1 AND client_action_id=$2 FOR UPDATE`,
      [context.organisationId, input.clientActionId]);
    const action = current.rows[0];
    if (!action) throw new CommandValidationError([{ field: "clientActionId", code: "NOT_FOUND", message: "That action does not exist." }]);
    if (action.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, action.version);
    if (!action.active) throw new CommandValidationError([{ field: "clientActionId", code: "REMOVED", message: "That action has been removed from the plan." }]);

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.client_actions
       SET status=$3, owner=$4, target_date=$5, progress_pct=$6, notes=$7,
           version=version+1, updated_at=now(), updated_by=$8
       WHERE organisation_id=$1 AND client_action_id=$2 RETURNING version`,
      [context.organisationId, input.clientActionId, input.status, input.owner?.trim() ?? "",
        input.targetDate ?? null, input.progressPct, input.notes?.trim() ?? "", context.actorId]);
    return {
      data: { clientActionId: input.clientActionId, version: saved.rows[0]!.version },
      entityType: "client_action", entityId: input.clientActionId, topic: "client.action.updated",
      before: { status: action.status, progressPct: action.progress_pct, owner: action.owner, targetDate: dateOnly(action.target_date) },
      after: { status: input.status, progressPct: input.progressPct, owner: input.owner?.trim() ?? "", targetDate: input.targetDate ?? null },
    };
  });
}

export type RemoveActionResult = { clientActionId: string; version: number };

/**
 * Taking an action off the plan.
 *
 * Deactivated, never deleted: what a client once intended to do is part of the history of
 * the engagement, and a published report citing it must not end up pointing at nothing.
 */
export function removeClientAction(pool: PoolLike, input: CommandInputMap["client.action.remove"], context: CommandContext): Promise<StoredOutcome<RemoveActionResult>> {
  return runPostgresCommand(pool, "client.action.remove", input, context, async (db) => {
    const current = await db.query<{ version: number; active: boolean }>(
      `SELECT version, active FROM nzi_console.client_actions
       WHERE organisation_id=$1 AND client_action_id=$2 FOR UPDATE`,
      [context.organisationId, input.clientActionId]);
    const action = current.rows[0];
    if (!action) throw new CommandValidationError([{ field: "clientActionId", code: "NOT_FOUND", message: "That action does not exist." }]);
    if (action.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, action.version);

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.client_actions SET active=false, version=version+1, updated_at=now(), updated_by=$3
       WHERE organisation_id=$1 AND client_action_id=$2 RETURNING version`,
      [context.organisationId, input.clientActionId, context.actorId]);
    return {
      data: { clientActionId: input.clientActionId, version: saved.rows[0]!.version },
      entityType: "client_action", entityId: input.clientActionId, topic: "client.action.removed",
      before: { active: action.active }, after: { active: false },
    };
  });
}
