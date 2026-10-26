import { randomUUID } from "node:crypto";
import {
  strategyClientNextStatuses, strategyClientTransitionAllowed, strategyProgressForStatus, strategyStatusForProgress, strategyStatusLabels,
  type CommandContext, type CommandInputMap, type StrategyStatus,
} from "@nzi/contracts";
import { dateOnlyOrNull } from "./dates";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { assertOwnerContact, setStrategyAlignment } from "./reductionStrategies";

/**
 * Actions A2 — the client's hand in their own reduction plan, from the portal.
 *
 * Three writes, each into A1's model and nowhere else:
 *
 * - **add from the library** — lands as a normal plan action (`origin: plan`), **Proposed** (A1's rule: staff agree it),
 *   aligned to the library's own default alignment, and shown to the client;
 * - **propose a custom action** — lands as a **pending** `client_proposal`, off the plan and not reportable until staff
 *   decide it in the CRM (`strategyProposals.ts`);
 * - **update** — any client user may nominate an action's owner from the client's own contacts (A1's foreign key holds
 *   it to this client); only the **owner** moves the action's date, progress and status, along the owner's half of the
 *   ladder (`strategyClientTransitionAllowed`): never agreeing, declining or reopening a declined one.
 *
 * There is no delete. Removing an action from a plan is staff's, in the CRM, with a reason (A1's withdraw).
 *
 * The runner has already held the session to its own client and an active portal account (`authorizePortalPlanCommand`);
 * each handler still reads the row it changes and refuses anything the client is not shown.
 */

/**
 * The client contacts this portal user **is** — the same equivalence the portal invitation uses to say an invitee is one
 * of the client's contacts: the same client, the same address. An owner is a contact (A1, R4), so this is how "the
 * actions you own" is answered without a second notion of identity.
 */
export async function portalUserContactIds(db: Queryable, organisationId: string, portalUserId: string): Promise<string[]> {
  const rows = await db.query<{ contact_id: string }>(
    `SELECT k.contact_id
       FROM nzi_console.portal_users u
       JOIN nzi_console.client_contacts k
         ON (k.organisation_id, k.client_id) = (u.organisation_id, u.client_id) AND lower(trim(k.email)) = u.email_normalized
      WHERE u.organisation_id = $1 AND u.portal_user_id = $2`,
    [organisationId, portalUserId]);
  return rows.rows.map((row) => row.contact_id);
}

const portalOnly = (context: CommandContext, clientId: string) => {
  // The route sets clientId from the session; the runner checked it. Said again here, where the row is written.
  if (context.principal !== "portal" || context.portal?.clientId !== clientId) {
    throw new CommandValidationError([{ field: "clientId", code: "NOT_YOURS", message: "That is not your plan." }]);
  }
};

export type PortalAddStrategyResult = { clientStrategyId: string; strategyId: string; status: "proposed"; origin: "plan"; srsRequirementIds: string[] };

export function addPortalStrategy(pool: PoolLike, input: CommandInputMap["portal.strategy.add"], context: CommandContext): Promise<StoredOutcome<PortalAddStrategyResult>> {
  return runPostgresCommand(pool, "portal.strategy.add", input, context, async (db) => {
    portalOnly(context, input.clientId);
    const strategy = (await db.query<{ active: boolean; title: string }>(
      `SELECT active, title FROM nzi_console.reduction_strategies WHERE organisation_id = $1 AND strategy_id = $2`,
      [context.organisationId, input.strategyId])).rows[0];
    if (!strategy || !strategy.active) throw new CommandValidationError([{ field: "strategyId", code: "NOT_FOUND", message: "That action is no longer in the library." }]);
    const held = await db.query(
      `SELECT 1 FROM nzi_console.client_strategies WHERE organisation_id = $1 AND client_id = $2 AND strategy_id = $3 AND active`,
      [context.organisationId, input.clientId, input.strategyId]);
    if (held.rows[0]) throw new CommandValidationError([{ field: "strategyId", code: "ALREADY_ON_PLAN", message: "That action is already on your plan." }]);
    // The library's own alignment: a client is not asked which disclosure requirement it advances — the catalogue says,
    // and the consultant can change it when they agree it.
    const defaults = (await db.query<{ requirement_id: string }>(
      `SELECT DISTINCT requirement_id FROM nzi_console.strategy_srs_requirements WHERE organisation_id = $1 AND strategy_id = $2`,
      [context.organisationId, input.strategyId])).rows.map((row) => row.requirement_id);
    if (defaults.length === 0) throw new CommandValidationError([{ field: "strategyId", code: "NOT_READY", message: "That action cannot be added yet — ask your adviser." }]);

    const clientStrategyId = `caction-${randomUUID()}`;
    await db.query(
      `INSERT INTO nzi_console.client_strategies
         (organisation_id, client_strategy_id, client_id, strategy_id, created_by, status, origin, include_in_report)
       VALUES ($1, $2, $3, $4, $5, 'proposed', 'plan', true)`,
      [context.organisationId, clientStrategyId, input.clientId, input.strategyId, context.actorId]);
    await setStrategyAlignment(db, { organisationId: context.organisationId, clientStrategyId, requirementIds: defaults });
    return {
      data: { clientStrategyId, strategyId: input.strategyId, status: "proposed", origin: "plan", srsRequirementIds: [...defaults].sort() },
      entityType: "client_strategy", entityId: clientStrategyId, topic: "portal.strategy.added",
    };
  });
}

export type PortalProposeStrategyResult = { clientStrategyId: string; origin: "client_proposal"; proposalState: "pending"; status: "proposed" };

export function proposePortalStrategy(pool: PoolLike, input: CommandInputMap["portal.strategy.propose"], context: CommandContext): Promise<StoredOutcome<PortalProposeStrategyResult>> {
  return runPostgresCommand(pool, "portal.strategy.propose", input, context, async (db) => {
    portalOnly(context, input.clientId);
    const clientStrategyId = `caction-${randomUUID()}`;
    // A bespoke row (A1's shape), pending: control level and category are the consultant's to settle on approval.
    await db.query(
      `INSERT INTO nzi_console.client_strategies
         (organisation_id, client_strategy_id, client_id, bespoke_title, bespoke_scope, bespoke_category, bespoke_control_level, bespoke_icon_key,
          created_by, status, origin, proposal_state, proposal_note, include_in_report)
       VALUES ($1, $2, $3, $4, $5, '', 'direct_control', 'target', $6, 'proposed', 'client_proposal', 'pending', $7, true)`,
      [context.organisationId, clientStrategyId, input.clientId, input.title.trim(), input.scope, context.actorId, input.note?.trim() ?? ""]);
    return {
      data: { clientStrategyId, origin: "client_proposal", proposalState: "pending", status: "proposed" },
      entityType: "client_strategy", entityId: clientStrategyId, topic: "portal.strategy.proposed",
    };
  });
}

export type PortalUpdateStrategyResult = {
  clientStrategyId: string; version: number;
  status: StrategyStatus; progressPct: number; ownerContactId: string | null; targetDate: string | null;
};

export function updatePortalStrategy(pool: PoolLike, input: CommandInputMap["portal.strategy.update"], context: CommandContext): Promise<StoredOutcome<PortalUpdateStrategyResult>> {
  return runPostgresCommand(pool, "portal.strategy.update", input, context, async (db) => {
    const action = (await db.query<{
      version: number; active: boolean; client_id: string; status: StrategyStatus; progress_pct: number; owner_contact_id: string | null;
      target_date: Date | string | null; proposal_state: string | null; include_in_report: boolean;
    }>(
      `SELECT version, active, client_id, status, progress_pct, owner_contact_id, target_date, proposal_state, include_in_report
         FROM nzi_console.client_strategies WHERE organisation_id = $1 AND client_strategy_id = $2 FOR UPDATE`,
      [context.organisationId, input.clientStrategyId])).rows[0];
    if (!action) throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_FOUND", message: "That action is not on your plan." }]);
    portalOnly(context, action.client_id);
    // What the client is not shown, they cannot change: an action held back from them, or removed, reads as absent.
    if (!action.active || !action.include_in_report) throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_FOUND", message: "That action is not on your plan." }]);
    if (action.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, action.version);
    if (action.proposal_state === "pending" || action.proposal_state === "declined") {
      throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_ON_PLAN", message: "That is a proposal with your adviser — it can be updated once they take it forward." }]);
    }
    if (action.status === "declined") throw new CommandValidationError([{ field: "clientStrategyId", code: "DECLINED", message: "That action was declined; talk to your adviser about bringing it back." }]);

    // The owner (A2, R5): any client user nominates one of the client's own current contacts; A1's check and foreign key hold it.
    const nominating = input.ownerContactId !== undefined && (input.ownerContactId?.trim() || null) !== action.owner_contact_id;
    const ownerContactId = input.ownerContactId === undefined ? action.owner_contact_id : input.ownerContactId?.trim() || null;
    if (nominating && ownerContactId) await assertOwnerContact(db, context.organisationId, action.client_id, ownerContactId);

    // The work itself (A2, R4): the action's owner — as they stood before this change — moves its date, progress and status.
    const currentDate = dateOnlyOrNull(action.target_date);
    const touchesWork = (input.targetDate !== undefined && (input.targetDate ?? null) !== currentDate)
      || (input.status !== undefined && input.status !== action.status)
      || (input.progressPct !== undefined && input.progressPct !== action.progress_pct);
    if (touchesWork) {
      const mine = action.owner_contact_id !== null && (await portalUserContactIds(db, context.organisationId, context.actorId)).includes(action.owner_contact_id);
      if (!mine) throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_THE_OWNER", message: "Only the action's owner updates its date, progress and status. Make yourself its owner first, if it is yours." }]);
    }

    // Status and progress are one fact seen two ways (0075's "complete means 100%"); each follows the other when only one moves.
    let status: StrategyStatus = (input.status as StrategyStatus | undefined) ?? action.status;
    let progressPct = input.progressPct ?? action.progress_pct;
    if (input.status !== undefined && input.progressPct === undefined) progressPct = strategyProgressForStatus(status, action.progress_pct);
    if (input.progressPct !== undefined && input.status === undefined) status = strategyStatusForProgress(input.progressPct, action.status);
    if ((status === "complete") !== (progressPct === 100)) {
      throw new CommandValidationError([{ field: "progressPct", code: "INCONSISTENT", message: "A complete action is at 100%, and an action at 100% is complete." }]);
    }
    if (!strategyClientTransitionAllowed(action.status, status)) {
      const next = strategyClientNextStatuses(action.status).filter((value) => value !== action.status).map((value) => strategyStatusLabels[value].toLowerCase());
      throw new CommandValidationError([{
        field: "status", code: "ILLEGAL_TRANSITION",
        message: next.length === 0
          ? `A ${strategyStatusLabels[action.status].toLowerCase()} action is moved on by your adviser.`
          : `A ${strategyStatusLabels[action.status].toLowerCase()} action can become ${next.join(" or ")} here; anything else is your adviser's.`,
      }]);
    }

    const targetDate = input.targetDate === undefined ? currentDate : input.targetDate ?? null;
    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.client_strategies
          SET status = $3, progress_pct = $4, owner_contact_id = $5, target_date = $6,
              legacy_owner_text = CASE WHEN $5::text IS NOT NULL THEN '' ELSE legacy_owner_text END,
              version = version + 1, updated_at = now(), updated_by = $7
        WHERE organisation_id = $1 AND client_strategy_id = $2 RETURNING version`,
      [context.organisationId, input.clientStrategyId, status, progressPct, ownerContactId, targetDate, context.actorId]);
    return {
      // Ids and states only — the owner by contact id, never by name.
      data: { clientStrategyId: input.clientStrategyId, version: saved.rows[0]!.version, status, progressPct, ownerContactId, targetDate },
      entityType: "client_strategy", entityId: input.clientStrategyId, topic: "portal.strategy.updated",
      before: { status: action.status, progressPct: action.progress_pct, ownerContactId: action.owner_contact_id, targetDate: currentDate },
    };
  });
}
