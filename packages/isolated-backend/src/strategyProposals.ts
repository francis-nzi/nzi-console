import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap, StrategyProposalState } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { assertOwnerContact, setStrategyAlignment, setStrategyLevers } from "./reductionStrategies";

/**
 * Actions A2, R2/R3 — staff rule on a client's proposal.
 *
 * A client proposes a custom action in the portal (`portal.strategy.propose`): it lands on `client_strategies` as a
 * **pending** proposal, off the plan and unaligned. Here staff decide it, once (0188 holds the "once"):
 *
 * - **approve** — it becomes a real plan action: the consultant settles its wording, scope and control level, aligns it
 *   to what it advances (the rule every action on a plan obeys), and it is **Agreed** — A1's Proposed → Agreed, made by
 *   staff as it always is;
 * - **decline** — it stays off the plan, Declined, with the reason the client is shown in the portal.
 *
 * And an approved one may be **promoted** into the shared library — a copy for every other client, under the library
 * capability (`admin.lookups`), never automatically and never by the client. The client's own action stays bespoke.
 *
 * Nothing here names who decided. The audit trail records the actor; the client sees the firm (NZC-110).
 */

type ProposalRow = {
  version: number; active: boolean; client_id: string; origin: string; proposal_state: StrategyProposalState | null;
  bespoke_title: string | null; bespoke_scope: string | null; bespoke_category: string | null; bespoke_control_level: string | null; bespoke_icon_key: string | null;
  proposal_note: string;
};

async function lockProposal(db: Queryable, organisationId: string, clientStrategyId: string, expectedVersion: number): Promise<ProposalRow> {
  const row = (await db.query<ProposalRow>(
    `SELECT version, active, client_id, origin, proposal_state, bespoke_title, bespoke_scope, bespoke_category, bespoke_control_level, bespoke_icon_key, proposal_note
       FROM nzi_console.client_strategies WHERE organisation_id = $1 AND client_strategy_id = $2 FOR UPDATE`,
    [organisationId, clientStrategyId])).rows[0];
  if (!row) throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_FOUND", message: "That action does not exist." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  if (!row.active) throw new CommandValidationError([{ field: "clientStrategyId", code: "REMOVED", message: "That action has been removed." }]);
  if (row.origin !== "client_proposal") throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_A_PROPOSAL", message: "That action was not proposed by the client." }]);
  return row;
}

const awaitingDecision = (row: ProposalRow) => {
  if (row.proposal_state !== "pending") {
    throw new CommandValidationError([{ field: "clientStrategyId", code: "ALREADY_DECIDED", message: `This proposal has already been ${row.proposal_state}.` }]);
  }
};

export type ApproveProposalResult = {
  clientStrategyId: string; version: number;
  /** The state as saved — the audit event's after_json. Ids and states only. */
  status: "agreed"; proposalState: "approved"; includeInReport: boolean; ownerContactId: string | null; targetDate: string | null; srsRequirementIds: string[];
};

export function approveClientProposal(pool: PoolLike, input: CommandInputMap["client.strategy.proposal.approve"], context: CommandContext): Promise<StoredOutcome<ApproveProposalResult>> {
  return runPostgresCommand(pool, "client.strategy.proposal.approve", input, context, async (db) => {
    const row = await lockProposal(db, context.organisationId, input.clientStrategyId, input.expectedVersion);
    awaitingDecision(row);
    const ownerContactId = input.ownerContactId?.trim() || null;
    if (ownerContactId) await assertOwnerContact(db, context.organisationId, row.client_id, ownerContactId);
    const targetDate = input.targetDate ?? null;
    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.client_strategies
          SET bespoke_title = $3, bespoke_scope = $4, bespoke_control_level = $5, bespoke_category = $6,
              status = 'agreed', proposal_state = 'approved', proposal_decided_at = now(), proposal_decided_by = $7,
              include_in_report = $8, owner_contact_id = $9, target_date = $10,
              version = version + 1, updated_at = now(), updated_by = $7
        WHERE organisation_id = $1 AND client_strategy_id = $2 RETURNING version`,
      [context.organisationId, input.clientStrategyId, input.title.trim(), input.scope, input.controlLevel, input.category?.trim() ?? "",
        context.actorId, input.includeInReport, ownerContactId, targetDate]);
    // Agreed and aligned in one transaction: the deferred alignment rule (0081) checks at COMMIT, when both are written.
    await setStrategyAlignment(db, { organisationId: context.organisationId, clientStrategyId: input.clientStrategyId, requirementIds: input.srsRequirementIds });
    return {
      data: { clientStrategyId: input.clientStrategyId, version: saved.rows[0]!.version, status: "agreed", proposalState: "approved",
        includeInReport: input.includeInReport, ownerContactId, targetDate, srsRequirementIds: [...new Set(input.srsRequirementIds)].sort() },
      entityType: "client_strategy", entityId: input.clientStrategyId, topic: "client.strategy.proposal.approved",
      before: { status: "proposed", proposalState: "pending", title: row.bespoke_title, scope: row.bespoke_scope },
    };
  });
}

export type DeclineProposalResult = { clientStrategyId: string; version: number; status: "declined"; proposalState: "declined" };

export function declineClientProposal(pool: PoolLike, input: CommandInputMap["client.strategy.proposal.decline"], context: CommandContext): Promise<StoredOutcome<DeclineProposalResult>> {
  return runPostgresCommand(pool, "client.strategy.proposal.decline", input, context, async (db) => {
    const row = await lockProposal(db, context.organisationId, input.clientStrategyId, input.expectedVersion);
    awaitingDecision(row);
    // The reason is the client's to read (it is what "Not taken forward" says), and the audit event's reason too.
    const saved = await db.query<{ version: number }>(
      `UPDATE nzi_console.client_strategies
          SET status = 'declined', proposal_state = 'declined', proposal_decision_reason = $3, proposal_decided_at = now(), proposal_decided_by = $4,
              version = version + 1, updated_at = now(), updated_by = $4
        WHERE organisation_id = $1 AND client_strategy_id = $2 RETURNING version`,
      [context.organisationId, input.clientStrategyId, input.reason.trim(), context.actorId]);
    return {
      data: { clientStrategyId: input.clientStrategyId, version: saved.rows[0]!.version, status: "declined", proposalState: "declined" },
      entityType: "client_strategy", entityId: input.clientStrategyId, topic: "client.strategy.proposal.declined",
      before: { status: "proposed", proposalState: "pending" },
    };
  });
}

export type PromoteProposalResult = { strategyId: string; clientStrategyId: string; key: string; leverIds: string[]; srsRequirementIds: string[] };

export function promoteClientProposal(pool: PoolLike, input: CommandInputMap["strategy.library.promote"], context: CommandContext): Promise<StoredOutcome<PromoteProposalResult>> {
  return runPostgresCommand(pool, "strategy.library.promote", input, context, async (db) => {
    const row = (await db.query<ProposalRow>(
      `SELECT version, active, client_id, origin, proposal_state, bespoke_title, bespoke_scope, bespoke_category, bespoke_control_level, bespoke_icon_key, proposal_note
         FROM nzi_console.client_strategies WHERE organisation_id = $1 AND client_strategy_id = $2 FOR UPDATE`,
      [context.organisationId, input.clientStrategyId])).rows[0];
    if (!row) throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_FOUND", message: "That action does not exist." }]);
    // Only what staff have already approved becomes reusable: a pending idea or a declined one is not the library's.
    if (row.origin !== "client_proposal" || row.proposal_state !== "approved" || !row.active) {
      throw new CommandValidationError([{ field: "clientStrategyId", code: "NOT_PROMOTABLE", message: "Only a client's approved proposal can be added to the library." }]);
    }
    const promoted = await db.query<{ strategy_id: string }>(
      `SELECT strategy_id FROM nzi_console.reduction_strategies WHERE organisation_id = $1 AND promoted_from_client_strategy_id = $2`,
      [context.organisationId, input.clientStrategyId]);
    if (promoted.rows[0]) throw new CommandValidationError([{ field: "clientStrategyId", code: "ALREADY_PROMOTED", message: "This action is already in the library." }]);
    const key = input.key.trim().toLowerCase();
    const clash = await db.query<{ strategy_id: string }>(
      `SELECT strategy_id FROM nzi_console.reduction_strategies WHERE organisation_id = $1 AND strategy_key = $2`, [context.organisationId, key]);
    if (clash.rows[0]) throw new CommandValidationError([{ field: "key", code: "DUPLICATE", message: "A library strategy with that key already exists." }]);

    const strategyId = `lever-${randomUUID()}`;
    await db.query(
      `INSERT INTO nzi_console.reduction_strategies
         (organisation_id, strategy_id, strategy_key, title, description, scope, category, control_level, icon_key, created_by, promoted_from_client_strategy_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [context.organisationId, strategyId, key, row.bespoke_title, input.description?.trim() ?? "", row.bespoke_scope, row.bespoke_category ?? "",
        row.bespoke_control_level, row.bespoke_icon_key ?? "target", context.actorId, input.clientStrategyId]);
    const leverIds = await setStrategyLevers(db, context.organisationId, strategyId, input.leverIds);
    // Its default alignment is what staff aligned it to on approval — what the next client to add it inherits.
    const aligned = await db.query<{ requirement_id: string }>(
      `INSERT INTO nzi_console.strategy_srs_requirements (organisation_id, strategy_id, framework_id, requirement_id)
       SELECT organisation_id, $2, framework_id, requirement_id FROM nzi_console.client_strategy_srs_requirements
        WHERE organisation_id = $1 AND client_strategy_id = $3
       RETURNING requirement_id`,
      [context.organisationId, strategyId, input.clientStrategyId]);
    return {
      data: { strategyId, clientStrategyId: input.clientStrategyId, key, leverIds, srsRequirementIds: [...new Set(aligned.rows.map((entry) => entry.requirement_id))].sort() },
      entityType: "reduction_strategy", entityId: strategyId, topic: "strategy.library.promoted",
    };
  });
}
