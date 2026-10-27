import { randomUUID } from "node:crypto";
import type { Lever, LibraryStrategy, StrategyScope, StrategyControlLevel, StrategyStatus, StrategyOrigin, StrategyProposalState, ClientStrategy, CommandContext, CommandInputMap, StrategyEstimate } from "@nzi/contracts";
import { londonDayOf, resolveEstimateTco2e, strategyNextStatuses, strategyStatusLabels, strategyTransitionAllowed } from "@nzi/contracts";
import { getBenchmarkInForce } from "./clientTargetRecords";
import { dateOnlyOrNull } from "./dates";
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
  srs_requirement_ids: string[] | null;
};

const mapStrategy = (row: StrategyRow): LibraryStrategy => ({
  id: row.strategy_id, key: row.strategy_key, title: row.title, description: row.description,
  scope: row.scope as StrategyScope, category: row.category,
  controlLevel: row.control_level as StrategyControlLevel, iconKey: row.icon_key,
  leverIds: row.lever_ids ?? [],
  defaultSrsRequirementIds: row.srs_requirement_ids ?? [],
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
  coalesce(array_agg(DISTINCT sl.lever_id) FILTER (WHERE sl.lever_id IS NOT NULL), '{}') AS lever_ids,
  coalesce(array_agg(DISTINCT sr.requirement_id) FILTER (WHERE sr.requirement_id IS NOT NULL), '{}') AS srs_requirement_ids`;

/** The levers, in the order Admin set — the plan's grouping follows this. */
export async function listLevers(db: Queryable): Promise<Lever[]> {
  const result = await db.query<{ lever_id: string; lever_key: string; title: string; icon_key: string; ordering: number; active: boolean; version: number }>(
    `SELECT lever_id, lever_key, title, icon_key, ordering, active, version
     FROM nzi_console.levers ORDER BY ordering, lower(title)`);
  return result.rows.map((row) => ({
    id: row.lever_id, key: row.lever_key, title: row.title,
    iconKey: row.icon_key, ordering: row.ordering, active: row.active, version: row.version,
  }));
}

export async function listLibraryStrategies(db: Queryable): Promise<LibraryStrategy[]> {
  const result = await db.query<StrategyRow>(
    `SELECT ${STRATEGY_COLUMNS}
     FROM nzi_console.reduction_strategies s
     LEFT JOIN nzi_console.strategy_levers sl ON (sl.organisation_id, sl.strategy_id) = (s.organisation_id, s.strategy_id)
     LEFT JOIN nzi_console.strategy_srs_requirements sr ON (sr.organisation_id, sr.strategy_id) = (s.organisation_id, s.strategy_id)
     GROUP BY s.organisation_id, s.strategy_id
     ORDER BY s.control_level, lower(s.title)`);
  return result.rows.map(mapStrategy);
}

type ClientStrategyRow = {
  client_strategy_id: string; client_id: string; strategy_id: string | null;
  bespoke_title: string | null; bespoke_scope: string | null; bespoke_category: string | null;
  bespoke_control_level: string | null; bespoke_icon_key: string | null;
  status: string; legacy_owner_text: string; owner_contact_id: string | null; owner_contact_name: string | null;
  origin: string; origin_srs_requirement_id: string | null;
  proposal_state: string | null; proposal_note: string; proposal_decision_reason: string | null;
  created_at: Date | string; proposal_decided_at: Date | string | null;
  target_date: Date | string | null; progress_pct: number;
  notes: string; active: boolean; version: number;
  estimate_amount: string | null; estimate_unit: string | null; estimate_scope: string | null;
  estimate_tco2e_per_year: string | null; estimate_assumptions: string; estimate_confidence: string | null;
  estimate_source: string | null; estimate_source_version: number | null;
  strategy_title: string | null; strategy_scope: string | null; strategy_category: string | null;
  strategy_control_level: string | null; strategy_icon: string | null;
  lever_ids: string[] | null;
  srs_requirement_ids: string[] | null;
  include_in_report: boolean;
};

// `target_date` is a SQL `date` (0075, 0083). It reaches the audit trail as well as the
// screen, so a shifted read would be written down as history.

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
  srsRequirementIds: row.srs_requirement_ids ?? [],
  includeInReport: row.include_in_report,
  status: row.status as StrategyStatus,
  // The owning contact's name (A1); else what 0075's free text held; an erased contact's name is gone, so "".
  owner: row.owner_contact_id !== null ? row.owner_contact_name ?? "" : row.legacy_owner_text,
  ownerContactId: row.owner_contact_id,
  origin: row.origin as StrategyOrigin, originSrsRequirementId: row.origin_srs_requirement_id,
  // A2: the decision on a client's proposal — dates, never who decided (NZC-110).
  proposal: (row.proposal_state ?? null) === null ? null : {
    state: row.proposal_state as StrategyProposalState, note: row.proposal_note, decisionReason: row.proposal_decision_reason,
    proposedOn: londonDayOf(row.created_at), decidedOn: (row.proposal_decided_at ?? null) === null ? null : londonDayOf(row.proposal_decided_at!),
  },
  targetDate: dateOnlyOrNull(row.target_date), progressPct: row.progress_pct,
  notes: row.notes, active: row.active, version: row.version,
  estimate: mapEstimate(row),
});

/**
 * The estimate, or null when none was entered.
 *
 * The database constraint makes a partial estimate impossible, so a present amount means
 * every part is present. Null is "not estimated" — a different fact from zero, which would
 * say the strategy saves nothing.
 */
const mapEstimate = (row: ClientStrategyRow): StrategyEstimate | null => {
  if (row.estimate_amount === null || row.estimate_unit === null || row.estimate_scope === null) return null;
  if (row.estimate_tco2e_per_year === null || row.estimate_source === null) return null;
  return {
    amount: Number(row.estimate_amount),
    unit: row.estimate_unit as StrategyEstimate["unit"],
    scope: row.estimate_scope as StrategyEstimate["scope"],
    tco2ePerYear: Number(row.estimate_tco2e_per_year),
    assumptions: row.estimate_assumptions,
    confidence: (row.estimate_confidence as StrategyEstimate["confidence"]) ?? null,
    source: row.estimate_source as StrategyEstimate["source"],
    sourceVersion: row.estimate_source_version,
  };
};

export async function listClientStrategies(db: Queryable, clientId: string): Promise<ClientStrategy[]> {
  const result = await db.query<ClientStrategyRow>(
    `SELECT a.client_strategy_id, a.client_id, a.strategy_id, a.bespoke_title, a.bespoke_scope, a.bespoke_category,
            a.bespoke_control_level, a.bespoke_icon_key, a.status, a.legacy_owner_text, a.owner_contact_id,
            oc.full_name AS owner_contact_name, a.origin, a.origin_srs_requirement_id, a.target_date, a.progress_pct,
            a.proposal_state, a.proposal_note, a.proposal_decision_reason, a.created_at, a.proposal_decided_at,
            a.notes, a.active, a.version, a.include_in_report,
            a.estimate_amount::text, a.estimate_unit, a.estimate_scope, a.estimate_tco2e_per_year::text,
            a.estimate_assumptions, a.estimate_confidence, a.estimate_source, a.estimate_source_version,
            l.title AS strategy_title, l.scope AS strategy_scope, l.category AS strategy_category,
            l.control_level AS strategy_control_level, l.icon_key AS strategy_icon,
            coalesce(array_agg(DISTINCT sl.lever_id) FILTER (WHERE sl.lever_id IS NOT NULL), '{}') AS lever_ids,
            -- The client's OWN alignment, not the library default it started from: a
            -- consultant may have changed it, and the report must quote what they chose.
            coalesce(array_agg(DISTINCT cr.requirement_id) FILTER (WHERE cr.requirement_id IS NOT NULL), '{}') AS srs_requirement_ids
     FROM nzi_console.client_strategies a
     LEFT JOIN nzi_console.reduction_strategies l ON (l.organisation_id, l.strategy_id) = (a.organisation_id, a.strategy_id)
     LEFT JOIN nzi_console.strategy_levers sl ON (sl.organisation_id, sl.strategy_id) = (l.organisation_id, l.strategy_id)
     LEFT JOIN nzi_console.client_strategy_srs_requirements cr ON (cr.organisation_id, cr.client_strategy_id) = (a.organisation_id, a.client_strategy_id)
     LEFT JOIN nzi_console.client_contacts oc ON (oc.organisation_id, oc.contact_id) = (a.organisation_id, a.owner_contact_id)
     WHERE a.client_id = $1
     GROUP BY a.organisation_id, a.client_strategy_id, l.title, l.scope, l.category, l.control_level, l.icon_key, oc.full_name
     ORDER BY a.created_at, a.client_strategy_id`, [clientId]);
  return result.rows.map(mapClientStrategy);
}

/* ── The catalogue ───────────────────────────────────────────────────────────────────── */

/**
 * Allocate a library strategy to its levers (A1, R1), replacing what it had. Every lever must be this organisation's;
 * a withdrawn one may stay where it already was but is not newly allocated, as a withdrawn strategy is not newly
 * assigned. Returns the allocation as saved, sorted, for the audit trail.
 */
export async function setStrategyLevers(db: Queryable, organisationId: string, strategyId: string, leverIds: readonly string[]): Promise<string[]> {
  const wanted = [...new Set(leverIds.map((id) => id.trim()).filter(Boolean))].sort();
  const known = await db.query<{ lever_id: string; active: boolean; held: boolean }>(
    `SELECT l.lever_id, l.active,
            EXISTS (SELECT 1 FROM nzi_console.strategy_levers x WHERE (x.organisation_id, x.strategy_id, x.lever_id) = (l.organisation_id, $2, l.lever_id)) AS held
       FROM nzi_console.levers l WHERE l.organisation_id = $1 AND l.lever_id = ANY($3::text[])`,
    [organisationId, strategyId, wanted]);
  const byId = new Map(known.rows.map((row) => [row.lever_id, row]));
  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length) throw new CommandValidationError([{ field: "leverIds", code: "NOT_FOUND", message: "One of those levers is not in the library." }]);
  if (wanted.some((id) => !byId.get(id)!.active && !byId.get(id)!.held)) {
    throw new CommandValidationError([{ field: "leverIds", code: "WITHDRAWN", message: "That lever has been withdrawn; it cannot be newly allocated." }]);
  }
  await db.query(`DELETE FROM nzi_console.strategy_levers WHERE organisation_id = $1 AND strategy_id = $2`, [organisationId, strategyId]);
  await db.query(
    `INSERT INTO nzi_console.strategy_levers (organisation_id, strategy_id, lever_id) SELECT $1, $2, unnest($3::text[])`,
    [organisationId, strategyId, wanted]);
  return wanted;
}

const leversOf = async (db: Queryable, organisationId: string, strategyId: string) =>
  (await db.query<{ lever_id: string }>(
    `SELECT lever_id FROM nzi_console.strategy_levers WHERE organisation_id = $1 AND strategy_id = $2 ORDER BY lever_id`,
    [organisationId, strategyId])).rows.map((row) => row.lever_id);

export type UpsertLeverResult = { leverId: string; version: number; created: boolean };

/** Add or edit a lever (A1, R1): admin-managed reference data, versioned on edit, the key unique per organisation. */
export function upsertLever(pool: PoolLike, input: CommandInputMap["strategy.lever.upsert"], context: CommandContext): Promise<StoredOutcome<UpsertLeverResult>> {
  return runPostgresCommand<"strategy.lever.upsert", UpsertLeverResult>(pool, "strategy.lever.upsert", input, context, async (db) => {
    const key = input.key.trim().toLowerCase();
    const title = input.title.trim();
    const clash = await db.query<{ lever_id: string }>(
      `SELECT lever_id FROM nzi_console.levers WHERE organisation_id = $1 AND lever_key = $2`, [context.organisationId, key]);
    if (clash.rows[0] && clash.rows[0].lever_id !== input.leverId) {
      throw new CommandValidationError([{ field: "key", code: "DUPLICATE", message: "A lever with that key already exists." }]);
    }
    if (input.leverId === undefined) {
      const leverId = `lever-${randomUUID()}`;
      const ordering = input.ordering ?? (await db.query<{ next: number }>(
        `SELECT coalesce(max(ordering), 0) + 1 AS next FROM nzi_console.levers WHERE organisation_id = $1`, [context.organisationId])).rows[0]!.next;
      await db.query(
        `INSERT INTO nzi_console.levers (organisation_id, lever_id, lever_key, title, icon_key, ordering, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [context.organisationId, leverId, key, title, input.iconKey.trim(), ordering, context.actorId]);
      return {
        data: { leverId, version: 1, created: true },
        entityType: "reduction_lever", entityId: leverId, topic: "strategy.lever.upserted",
        after: { key, title, iconKey: input.iconKey.trim(), ordering },
      };
    }
    const current = await db.query<{ version: number; lever_key: string; title: string; icon_key: string; ordering: number }>(
      `SELECT version, lever_key, title, icon_key, ordering FROM nzi_console.levers WHERE organisation_id = $1 AND lever_id = $2 FOR UPDATE`,
      [context.organisationId, input.leverId]);
    const lever = current.rows[0];
    if (!lever) throw new CommandValidationError([{ field: "leverId", code: "NOT_FOUND", message: "That lever is not in the library." }]);
    if (lever.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion!, lever.version);
    const ordering = input.ordering ?? lever.ordering;
    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.levers SET lever_key = $3, title = $4, icon_key = $5, ordering = $6, version = version + 1, updated_at = now(), updated_by = $7
        WHERE organisation_id = $1 AND lever_id = $2 RETURNING version`,
      [context.organisationId, input.leverId, key, title, input.iconKey.trim(), ordering, context.actorId]);
    return {
      data: { leverId: input.leverId, version: saved.rows[0]!.version, created: false },
      entityType: "reduction_lever", entityId: input.leverId, topic: "strategy.lever.upserted",
      before: { key: lever.lever_key, title: lever.title, iconKey: lever.icon_key, ordering: lever.ordering },
      after: { key, title, iconKey: input.iconKey.trim(), ordering },
    };
  });
}

export type DeactivateLeverResult = { leverId: string; version: number; strategiesUnder: number };

/**
 * Withdraw a lever (A1, R1): deactivated, never deleted. The strategies under it keep the allocation — a plan grouped by
 * lever shows a strategy whose only lever is withdrawn under "Other" rather than losing it — and the count comes back so
 * the Admin knows what they have just moved.
 */
export function deactivateLever(pool: PoolLike, input: CommandInputMap["strategy.lever.deactivate"], context: CommandContext): Promise<StoredOutcome<DeactivateLeverResult>> {
  return runPostgresCommand<"strategy.lever.deactivate", DeactivateLeverResult>(pool, "strategy.lever.deactivate", input, context, async (db) => {
    const current = await db.query<{ version: number; active: boolean; title: string }>(
      `SELECT version, active, title FROM nzi_console.levers WHERE organisation_id = $1 AND lever_id = $2 FOR UPDATE`,
      [context.organisationId, input.leverId]);
    const lever = current.rows[0];
    if (!lever) throw new CommandValidationError([{ field: "leverId", code: "NOT_FOUND", message: "That lever is not in the library." }]);
    if (lever.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, lever.version);
    if (!lever.active) throw new CommandValidationError([{ field: "leverId", code: "ALREADY_WITHDRAWN", message: "That lever is already withdrawn." }]);
    const under = await db.query<{ count: string }>(
      `SELECT count(*)::text FROM nzi_console.strategy_levers WHERE organisation_id = $1 AND lever_id = $2`, [context.organisationId, input.leverId]);
    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.levers SET active = false, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND lever_id = $2 RETURNING version`,
      [context.organisationId, input.leverId, context.actorId]);
    return {
      data: { leverId: input.leverId, version: saved.rows[0]!.version, strategiesUnder: Number(under.rows[0]?.count ?? 0) },
      entityType: "reduction_lever", entityId: input.leverId, topic: "strategy.lever.deactivated",
      before: { active: true }, after: { active: false, title: lever.title },
    };
  });
}

/** `leverIds` as allocated — the audit event's after_json, so a re-allocation is on the record (A1). */
export type UpsertStrategyResult = { strategyId: string; version: number; created: boolean; leverIds: string[] };

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
      const leverIds = await setStrategyLevers(db, context.organisationId, strategyId, input.leverIds);
      const data: UpsertStrategyResult = { strategyId, version: 1, created: true, leverIds };
      return {
        data,
        entityType: "reduction_strategy", entityId: strategyId, topic: "strategy.library.upserted",
        after: { key, title, scope: input.scope, controlLevel: input.controlLevel, leverIds },
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
    const beforeLevers = await leversOf(db, context.organisationId, input.strategyId);
    const leverIds = await setStrategyLevers(db, context.organisationId, input.strategyId, input.leverIds);
    const data: UpsertStrategyResult = { strategyId: input.strategyId, version: saved.rows[0]!.version, created: false, leverIds };
    return {
      data,
      entityType: "reduction_strategy", entityId: input.strategyId, topic: "strategy.library.upserted",
      before: { key: strategy.strategy_key, title: strategy.title, scope: strategy.scope, controlLevel: strategy.control_level, leverIds: beforeLevers },
      after: { key, title, scope: input.scope, controlLevel: input.controlLevel, leverIds },
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


/**
 * Replace a client strategy's SRS alignment.
 *
 * Written in the same transaction as the strategy itself, which is why the database rule is
 * a DEFERRED constraint trigger: an immediate check would fire between these two statements,
 * when the strategy exists and its alignments do not.
 */
export async function setStrategyAlignment(db: Queryable, input: {
  organisationId: string; clientStrategyId: string; requirementIds: readonly string[];
}): Promise<void> {
  await db.query(
    `DELETE FROM nzi_console.client_strategy_srs_requirements
     WHERE organisation_id=$1 AND client_strategy_id=$2`,
    [input.organisationId, input.clientStrategyId]);

  // The framework comes from the requirement itself rather than from the caller: an
  // alignment must point at a requirement that really exists, in the framework it belongs
  // to, and taking the caller's word for that is how a dangling reference gets in.
  const written = await db.query<{ requirement_id: string }>(
    `INSERT INTO nzi_console.client_strategy_srs_requirements
       (organisation_id, client_strategy_id, framework_id, requirement_id)
     SELECT r.organisation_id, $2, r.framework_id, r.requirement_id
     FROM nzi_console.srs_requirements r
     WHERE r.organisation_id=$1 AND r.requirement_id = ANY($3::text[])
     ON CONFLICT DO NOTHING
     RETURNING requirement_id`,
    [input.organisationId, input.clientStrategyId, [...new Set(input.requirementIds)]]);

  // An id that matched no requirement would leave the strategy with fewer alignments than
  // the consultant chose — or none at all, which the deferred trigger would then reject
  // with a message about the strategy rather than about the id that was wrong.
  if (written.rows.length === 0) {
    throw new CommandValidationError([{
      field: "srsRequirementIds", code: "UNKNOWN_REQUIREMENT",
      message: "None of those UK SRS requirements exist in the framework in force.",
    }]);
  }
}

/**
 * The owner must be one of this client's contacts, and a current one (A1, R4). The foreign key holds the first half
 * (it runs through `client_id`); saying it here names the problem instead of a constraint. A contact who has since
 * become inactive may stay as an existing owner — the check is on choosing one.
 */
export async function assertOwnerContact(db: Queryable, organisationId: string, clientId: string, contactId: string): Promise<void> {
  const contact = (await db.query<{ client_id: string; status: string }>(
    `SELECT client_id, status FROM nzi_console.client_contacts WHERE organisation_id = $1 AND contact_id = $2`, [organisationId, contactId])).rows[0];
  if (!contact || contact.client_id !== clientId) {
    throw new CommandValidationError([{ field: "ownerContactId", code: "NOT_A_CONTACT", message: "The owner must be one of this client's contacts." }]);
  }
  if (contact.status !== "active") throw new CommandValidationError([{ field: "ownerContactId", code: "INACTIVE", message: "That contact is no longer active; choose a current one." }]);
}

/**
 * The UK SRS requirement an `srs_gap` action bridges (A1, R7), with the framework it belongs to — taken from the
 * requirement, never the caller, as the alignment is. Where the id appears in more than one framework version, the one
 * in force wins, then the newest.
 */
export async function gapRequirement(db: Queryable, organisationId: string, requirementId: string): Promise<{ frameworkId: string; requirementId: string }> {
  const found = (await db.query<{ framework_id: string }>(
    `SELECT r.framework_id FROM nzi_console.srs_requirements r
       JOIN nzi_console.srs_frameworks f ON (f.organisation_id, f.framework_id) = (r.organisation_id, r.framework_id)
      WHERE r.organisation_id = $1 AND r.requirement_id = $2
      ORDER BY (f.status = 'active') DESC, f.version DESC LIMIT 1`, [organisationId, requirementId])).rows[0];
  if (!found) throw new CommandValidationError([{ field: "originSrsRequirementId", code: "UNKNOWN_REQUIREMENT", message: "That UK SRS requirement does not exist." }]);
  return { frameworkId: found.framework_id, requirementId };
}

/** What an assignment records — the audit event's after_json — ids and states only (A1). */
export type AssignStrategyResult = {
  clientStrategyId: string; strategyId: string | null;
  status: StrategyStatus; ownerContactId: string | null; origin: StrategyOrigin; originSrsRequirementId: string | null;
};

export function assignClientStrategy(pool: PoolLike, input: CommandInputMap["client.strategy.assign"], context: CommandContext): Promise<StoredOutcome<AssignStrategyResult>> {
  return runPostgresCommand(pool, "client.strategy.assign", input, context, async (db) => {
    const clientStrategyId = `caction-${randomUUID()}`;
    const targetDate = input.targetDate ?? null;
    // A1: it enters the ladder proposed (or agreed, where the client already has); its owner is one of their contacts;
    // and it says where it came from. An SRS-gap action is aligned to the gap it bridges as well as anything chosen.
    const status = input.status === "agreed" ? "agreed" : "proposed";
    const ownerContactId = input.ownerContactId?.trim() || null;
    if (ownerContactId) await assertOwnerContact(db, context.organisationId, input.clientId, ownerContactId);
    const origin: StrategyOrigin = input.origin === "srs_gap" ? "srs_gap" : "plan";
    const gap = origin === "srs_gap" ? await gapRequirement(db, context.organisationId, input.originSrsRequirementId!.trim()) : null;
    const requirementIds = gap ? [...new Set([...input.srsRequirementIds, gap.requirementId])] : input.srsRequirementIds;
    const ladder = [status, ownerContactId, origin, gap?.frameworkId ?? null, gap?.requirementId ?? null] as const;

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
           (organisation_id, client_strategy_id, client_id, strategy_id, target_date, notes, created_by,
            status, owner_contact_id, origin, origin_srs_framework_id, origin_srs_requirement_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [context.organisationId, clientStrategyId, input.clientId, input.strategyId, targetDate, input.notes?.trim() ?? "", context.actorId, ...ladder]);
      await setStrategyAlignment(db, { organisationId: context.organisationId, clientStrategyId, requirementIds });
      const data: AssignStrategyResult = { clientStrategyId, strategyId: input.strategyId, status, ownerContactId, origin, originSrsRequirementId: gap?.requirementId ?? null };
      return {
        data,
        entityType: "client_strategy", entityId: clientStrategyId, topic: "client.strategy.assigned",
        after: { clientId: input.clientId, strategyId: input.strategyId, title: strategy.rows[0].title, status, ownerContactId, origin, originSrsRequirementId: gap?.requirementId ?? null },
      };
    }

    const bespoke = input.bespoke!;
    await db.query(
      `INSERT INTO nzi_console.client_strategies
         (organisation_id, client_strategy_id, client_id, bespoke_title, bespoke_scope, bespoke_category,
          bespoke_control_level, bespoke_icon_key, target_date, notes, created_by,
          status, owner_contact_id, origin, origin_srs_framework_id, origin_srs_requirement_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [context.organisationId, clientStrategyId, input.clientId, bespoke.title.trim(), bespoke.scope,
        bespoke.category?.trim() ?? "", bespoke.controlLevel, bespoke.iconKey ?? "target",
        targetDate, input.notes?.trim() ?? "", context.actorId, ...ladder]);
    await setStrategyAlignment(db, { organisationId: context.organisationId, clientStrategyId, requirementIds });
    const data: AssignStrategyResult = { clientStrategyId, strategyId: null, status, ownerContactId, origin, originSrsRequirementId: gap?.requirementId ?? null };
    return {
      data,
      entityType: "client_strategy", entityId: clientStrategyId, topic: "client.strategy.assigned",
      after: { clientId: input.clientId, bespoke: true, title: bespoke.title.trim(), status, ownerContactId, origin, originSrsRequirementId: gap?.requirementId ?? null },
    };
  });
}

export type UpdateStrategyResult = {
  clientStrategyId: string; version: number;
  /** The state as saved — the audit event's after_json (A1). */
  status: StrategyStatus; progressPct: number; ownerContactId: string | null; targetDate: string | null; includeInReport: boolean;
};

export function updateClientStrategy(pool: PoolLike, input: CommandInputMap["client.strategy.update"], context: CommandContext): Promise<StoredOutcome<UpdateStrategyResult>> {
  return runPostgresCommand(pool, "client.strategy.update", input, context, async (db) => {
    const current = await db.query<{ version: number; active: boolean; client_id: string; status: StrategyStatus; progress_pct: number; owner_contact_id: string | null; target_date: Date | string | null; include_in_report: boolean; proposal_state: string | null }>(
      `SELECT version, active, client_id, status, progress_pct, owner_contact_id, target_date, include_in_report, proposal_state FROM nzi_console.client_strategies
       WHERE organisation_id=$1 AND client_strategy_id=$2 FOR UPDATE`,
      [context.organisationId, input.clientStrategyId]);
    const action = current.rows[0];
    if (!action) throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_FOUND", message: "That action does not exist." }]);
    if (action.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, action.version);
    if (!action.active) throw new CommandValidationError([{ field: "clientStrategyId", code: "REMOVED", message: "That action has been removed from the plan." }]);
    // A2: a client's proposal is decided in the proposals queue, once — not edited onto the plan around that decision.
    if (action.proposal_state === "pending" || action.proposal_state === "declined") {
      throw new CommandValidationError([{ field: "clientStrategyId", code: "PROPOSAL_UNDECIDED", message: action.proposal_state === "pending" ? "This is a client's proposal — approve or decline it first." : "This client proposal was declined; it is not on the plan." }]);
    }

    // The ladder (A1, R3), checked against the status held under the row lock — not the one the form last saw.
    const status = input.status as StrategyStatus;
    if (!strategyTransitionAllowed(action.status, status)) {
      const next = strategyNextStatuses(action.status).filter((value) => value !== action.status).map((value) => strategyStatusLabels[value]);
      throw new CommandValidationError([{
        field: "status", code: "ILLEGAL_TRANSITION",
        message: `A ${strategyStatusLabels[action.status].toLowerCase()} action cannot become ${strategyStatusLabels[status].toLowerCase()}; it can become ${next.join(" or ").toLowerCase()}.`,
      }]);
    }

    // The owner (A1, R4): absent leaves it; null clears it; a new one must be this client's current contact. Choosing a
    // contact retires 0075's free-text owner — it said the same thing less precisely.
    const ownerChanges = input.ownerContactId !== undefined && (input.ownerContactId?.trim() || null) !== action.owner_contact_id;
    const ownerContactId = input.ownerContactId === undefined ? action.owner_contact_id : input.ownerContactId?.trim() || null;
    if (ownerChanges && ownerContactId) await assertOwnerContact(db, context.organisationId, action.client_id, ownerContactId);

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.client_strategies
       SET status=$3, owner_contact_id=$4, target_date=$5, progress_pct=$6, notes=$7, include_in_report=$9,
           legacy_owner_text = CASE WHEN $4::text IS NOT NULL THEN '' ELSE legacy_owner_text END,
           version=version+1, updated_at=now(), updated_by=$8
       WHERE organisation_id=$1 AND client_strategy_id=$2 RETURNING version`,
      [context.organisationId, input.clientStrategyId, status, ownerContactId,
        input.targetDate ?? null, input.progressPct, input.notes?.trim() ?? "", context.actorId, input.includeInReport]);
    await setStrategyAlignment(db, { organisationId: context.organisationId, clientStrategyId: input.clientStrategyId, requirementIds: input.srsRequirementIds });
    return {
      // The runner writes `data` as the audit event's after_json, so the new state travels here — ids and states only:
      // the owner is named by contact id, never by name (NZC-120).
      data: { clientStrategyId: input.clientStrategyId, version: saved.rows[0]!.version, status, progressPct: input.progressPct, ownerContactId,
        targetDate: input.targetDate ?? null, includeInReport: input.includeInReport },
      entityType: "client_strategy", entityId: input.clientStrategyId, topic: "client.strategy.updated",
      before: { status: action.status, progressPct: action.progress_pct, ownerContactId: action.owner_contact_id, targetDate: dateOnlyOrNull(action.target_date), includeInReport: action.include_in_report },
      after: { status, progressPct: input.progressPct, ownerContactId, targetDate: input.targetDate ?? null, includeInReport: input.includeInReport },
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

export type SetStrategyEstimateResult = { clientStrategyId: string; version: number; tco2ePerYear: number | null };

/**
 * Record what a strategy is expected to save — an estimate, resolved to tCO₂e/yr.
 *
 * A percent resolves against **this scope's share of the benchmark in force**, the same
 * denominator the target pathway uses, and the resolved figure is stored rather than
 * recomputed on read: a later re-baseline must not silently restate a number a consultant
 * agreed, for the same reason targets stamp the benchmark they were set against.
 *
 * Nothing here reads an assured snapshot. The estimate is a forward view and must never be
 * derived from, or presented as, the measured footprint.
 */
export function setClientStrategyEstimate(pool: PoolLike, input: CommandInputMap["client.strategy.estimate.set"], context: CommandContext): Promise<StoredOutcome<SetStrategyEstimateResult>> {
  return runPostgresCommand(pool, "client.strategy.estimate.set", input, context, async (db) => {
    const current = await db.query<{ version: number; active: boolean; client_id: string; estimate_tco2e_per_year: string | null }>(
      `SELECT version, active, client_id, estimate_tco2e_per_year FROM nzi_console.client_strategies
       WHERE organisation_id=$1 AND client_strategy_id=$2 FOR UPDATE`,
      [context.organisationId, input.clientStrategyId]);
    const strategy = current.rows[0];
    if (!strategy) throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_FOUND", message: "That strategy does not exist." }]);
    if (strategy.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, strategy.version);
    if (!strategy.active) throw new CommandValidationError([{ field: "clientStrategyId", code: "REMOVED", message: "That strategy has been removed from the plan." }]);

    let resolved: number | null = null;
    if (input.estimate !== null) {
      const benchmark = await getBenchmarkInForce(db, strategy.client_id);
      resolved = resolveEstimateTco2e(input.estimate, benchmark);
      if (resolved === null) {
        // Refused rather than stored as zero: "we could not resolve this" and "this saves
        // nothing" are opposite claims, and the roll-up would treat the zero as agreed.
        throw new CommandValidationError([{
          field: "amount", code: "UNRESOLVABLE",
          message: input.estimate.unit === "percent"
            ? `A percentage needs a baseline for scope ${input.estimate.scope}, and this client's benchmark in force has none. Enter the reduction in tCO₂e per year instead, or set the baseline first.`
            : "That reduction could not be resolved to tCO₂e per year.",
        }]);
      }
    }

    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.client_strategies
       SET estimate_amount=$3, estimate_unit=$4, estimate_scope=$5, estimate_tco2e_per_year=$6,
           estimate_assumptions=$7, estimate_confidence=$8, estimate_source=$9, estimate_source_version=$10,
           version=version+1, updated_at=now(), updated_by=$11
       WHERE organisation_id=$1 AND client_strategy_id=$2 RETURNING version`,
      [context.organisationId, input.clientStrategyId,
        input.estimate?.amount ?? null, input.estimate?.unit ?? null, input.estimate?.scope ?? null, resolved,
        input.estimate?.assumptions.trim() ?? "", input.estimate?.confidence ?? null,
        input.estimate?.source ?? null, input.estimate?.sourceVersion ?? null, context.actorId]);

    return {
      data: { clientStrategyId: input.clientStrategyId, version: saved.rows[0]!.version, tco2ePerYear: resolved },
      entityType: "client_strategy", entityId: input.clientStrategyId, topic: "client.strategy.estimate.set",
      before: { estimateTco2ePerYear: strategy.estimate_tco2e_per_year === null ? null : Number(strategy.estimate_tco2e_per_year) },
      after: { estimateTco2ePerYear: resolved, unit: input.estimate?.unit ?? null, source: input.estimate?.source ?? null },
    };
  });
}
