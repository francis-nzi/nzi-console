import { randomUUID } from "node:crypto";
import {
  londonDayOf, readinessReportTemplates,
  type CommandContext, type CommandInputMap, type SrsAssessment, type SrsFramework, type SrsGapSuggestion, type SrsMaturity, type StrategyStatus,
} from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { setStrategyAlignment } from "./reductionStrategies";
import { getSrsFramework } from "./srsReadinessRecords";

/**
 * SRS S3 — bridging a readiness gap, and the report export.
 *
 * A **gap** is a requirement below its own target in a client's assessment. Bridging it puts an action on the plan — the
 * one shared spine (A1) — with `origin: "srs_gap"` and the requirement it bridges (set once, A1's trigger), aligned to
 * that requirement. Where the assessment is still in progress it also takes the link back (`linked_action_id`, S1); a
 * completed assessment is a record S1 does not let change, so there the action's own origin is the link, and the
 * register resolves it that way (`srsBridgedBy`).
 *
 * AI ideas are stored and withdrawn here; they are **generated** elsewhere (`srsSuggestions.ts`), outside any
 * transaction, and arrive already grounded. Nothing in this file writes an idea onto the plan or into the library.
 */

/** The framework versions a client's assessments were made against, by id — so each is read against its own (S2 review). */
export async function srsFrameworksFor(db: Queryable, assessments: readonly SrsAssessment[]): Promise<Map<string, SrsFramework>> {
  const ids = [...new Set(assessments.map((assessment) => assessment.frameworkId))];
  const versions = await Promise.all(ids.map((id) => getSrsFramework(db, id)));
  return new Map(versions.filter((framework): framework is SrsFramework => framework !== null).map((framework) => [framework.frameworkId, framework]));
}

/** The AI ideas currently shown for a client, newest first — what the CRM and the portal both read. */
export async function listSrsGapSuggestions(db: Queryable, clientId: string): Promise<SrsGapSuggestion[]> {
  const rows = await db.query<{ suggestion_id: string; assessment_id: string; requirement_id: string; title: string; how: string; created_at: Date | string }>(
    `SELECT suggestion_id, assessment_id, requirement_id, title, how, created_at FROM nzi_console.srs_gap_suggestions
      WHERE client_id = $1 AND status = 'shown' ORDER BY created_at DESC, suggestion_id`, [clientId]);
  return rows.rows.map((row) => ({
    id: row.suggestion_id, assessmentId: row.assessment_id, requirementId: row.requirement_id, title: row.title, how: row.how,
    suggestedOn: londonDayOf(row.created_at), status: "shown",
  }));
}

type GapContext = { clientId: string; frameworkId: string; status: "draft" | "complete"; target: SrsMaturity; maturity: SrsMaturity | null; itemVersion: number | null };

/** The assessment and the requirement, held to being a real gap in it. */
async function gapIn(db: Queryable, organisationId: string, assessmentId: string, requirementId: string): Promise<GapContext> {
  const header = (await db.query<{ client_id: string; framework_id: string; status: "draft" | "complete" }>(
    `SELECT client_id, framework_id, status FROM nzi_console.srs_assessments WHERE organisation_id = $1 AND assessment_id = $2`,
    [organisationId, assessmentId])).rows[0];
  if (!header) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "That assessment does not exist." }]);
  const requirement = (await db.query<{ target_maturity: SrsMaturity }>(
    `SELECT target_maturity FROM nzi_console.srs_requirements WHERE organisation_id = $1 AND framework_id = $2 AND requirement_id = $3`,
    [organisationId, header.framework_id, requirementId])).rows[0];
  if (!requirement) throw new CommandValidationError([{ field: "requirementId", code: "UNKNOWN_REQUIREMENT", message: "That requirement is not in the framework this assessment was made against." }]);
  const item = (await db.query<{ maturity: SrsMaturity | null; version: number }>(
    `SELECT maturity, version FROM nzi_console.srs_assessment_items WHERE organisation_id = $1 AND assessment_id = $2 AND requirement_id = $3 FOR UPDATE`,
    [organisationId, assessmentId, requirementId])).rows[0];
  const maturity = item?.maturity ?? null;
  if (maturity !== null && maturity >= requirement.target_maturity) {
    throw new CommandValidationError([{ field: "requirementId", code: "NOT_A_GAP", message: "That requirement already meets what the framework expects." }]);
  }
  return { clientId: header.client_id, frameworkId: header.framework_id, status: header.status, target: requirement.target_maturity, maturity, itemVersion: item?.version ?? null };
}

export type RecordSuggestionsResult = { assessmentId: string; requirementId: string; suggestionIds: string[]; withdrawn: number; model: string; promptSha256: string };

/**
 * Store a gap's AI ideas as shown (R2), withdrawing the ones shown before for the same gap. The audit event carries the
 * request **by reference** — the model, the prompt's SHA-256, how many ideas — and not their text (R8).
 */
export function recordSrsGapSuggestions(pool: PoolLike, input: CommandInputMap["srs.gap.suggestions.record"], context: CommandContext): Promise<StoredOutcome<RecordSuggestionsResult>> {
  return runPostgresCommand(pool, "srs.gap.suggestions.record", input, context, async (db) => {
    const gap = await gapIn(db, context.organisationId, input.assessmentId, input.requirementId);
    const withdrawn = await db.query(
      `UPDATE nzi_console.srs_gap_suggestions SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = $4
        WHERE organisation_id = $1 AND client_id = $2 AND requirement_id = $3 AND status = 'shown' RETURNING suggestion_id`,
      [context.organisationId, gap.clientId, input.requirementId, context.actorId]);
    const suggestionIds: string[] = [];
    for (const suggestion of input.suggestions) {
      const suggestionId = `srsidea-${randomUUID()}`;
      await db.query(
        `INSERT INTO nzi_console.srs_gap_suggestions (organisation_id, suggestion_id, client_id, assessment_id, requirement_id, title, how, model, prompt_sha256, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [context.organisationId, suggestionId, gap.clientId, input.assessmentId, input.requirementId, suggestion.title.trim(), suggestion.how.trim(), input.model, input.promptSha256, context.actorId]);
      suggestionIds.push(suggestionId);
    }
    return {
      data: { assessmentId: input.assessmentId, requirementId: input.requirementId, suggestionIds, withdrawn: withdrawn.rows.length, model: input.model, promptSha256: input.promptSha256 },
      entityType: "srs_assessment", entityId: input.assessmentId, topic: "srs.gap.suggestions.recorded",
    };
  });
}

export type WithdrawSuggestionResult = { suggestionId: string; status: "withdrawn" };

/** Take an idea off what the client is shown. Withdrawn, never deleted: what was shown stays on the record. */
export function withdrawSrsGapSuggestion(pool: PoolLike, input: CommandInputMap["srs.gap.suggestion.withdraw"], context: CommandContext): Promise<StoredOutcome<WithdrawSuggestionResult>> {
  return runPostgresCommand(pool, "srs.gap.suggestion.withdraw", input, context, async (db) => {
    const saved = await db.query(
      `UPDATE nzi_console.srs_gap_suggestions SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by = $4
        WHERE organisation_id = $1 AND assessment_id = $2 AND suggestion_id = $3 AND status = 'shown' RETURNING suggestion_id`,
      [context.organisationId, input.assessmentId, input.suggestionId, context.actorId]);
    if (saved.rows.length === 0) throw new CommandValidationError([{ field: "suggestionId", code: "NOT_SHOWN", message: "That idea is not shown on this assessment." }]);
    return {
      data: { suggestionId: input.suggestionId, status: "withdrawn" },
      entityType: "srs_assessment", entityId: input.assessmentId, topic: "srs.gap.suggestion.withdrawn",
    };
  });
}

export type BridgeGapResult = {
  clientStrategyId: string; requirementId: string; origin: "srs_gap"; status: StrategyStatus;
  strategyId: string | null; fromSuggestionId: string | null;
  /** Whether the assessment took the link back — only one still in progress can (S1). */
  linked: boolean;
};

/**
 * Bridge a gap (R1): one action on the plan, `origin: "srs_gap"` naming the requirement, aligned to it — from the library
 * (whose own alignment must name the requirement: a match by alignment, not by words) or in the consultant's words,
 * optionally starting from an AI idea. Linked back from the assessment where it is still in progress.
 */
export function bridgeSrsGap(pool: PoolLike, input: CommandInputMap["srs.gap.bridge"], context: CommandContext): Promise<StoredOutcome<BridgeGapResult>> {
  return runPostgresCommand(pool, "srs.gap.bridge", input, context, async (db) => {
    const gap = await gapIn(db, context.organisationId, input.assessmentId, input.requirementId);
    const clientStrategyId = `caction-${randomUUID()}`;
    const status: StrategyStatus = input.status === "agreed" ? "agreed" : "proposed";
    const includeInReport = input.includeInReport ?? true;
    let requirementIds = [input.requirementId];
    let strategyId: string | null = null;

    if (input.strategyId) {
      const library = (await db.query<{ active: boolean }>(
        `SELECT active FROM nzi_console.reduction_strategies WHERE organisation_id = $1 AND strategy_id = $2`, [context.organisationId, input.strategyId])).rows[0];
      if (!library?.active) throw new CommandValidationError([{ field: "strategyId", code: "NOT_FOUND", message: "That action is not in the library." }]);
      const aligned = (await db.query<{ requirement_id: string }>(
        `SELECT DISTINCT requirement_id FROM nzi_console.strategy_srs_requirements WHERE organisation_id = $1 AND strategy_id = $2`,
        [context.organisationId, input.strategyId])).rows.map((row) => row.requirement_id);
      if (!aligned.includes(input.requirementId)) {
        throw new CommandValidationError([{ field: "strategyId", code: "NOT_ALIGNED", message: "That library action is not aligned to this requirement." }]);
      }
      const held = await db.query(
        `SELECT 1 FROM nzi_console.client_strategies WHERE organisation_id = $1 AND client_id = $2 AND strategy_id = $3 AND active`,
        [context.organisationId, gap.clientId, input.strategyId]);
      if (held.rows[0]) throw new CommandValidationError([{ field: "strategyId", code: "ALREADY_ON_PLAN", message: "That action is already on this client's plan." }]);
      strategyId = input.strategyId;
      requirementIds = [...new Set([...aligned, input.requirementId])];
      await db.query(
        `INSERT INTO nzi_console.client_strategies
           (organisation_id, client_strategy_id, client_id, strategy_id, created_by, status, origin, origin_srs_framework_id, origin_srs_requirement_id, include_in_report)
         VALUES ($1, $2, $3, $4, $5, $6, 'srs_gap', $7, $8, $9)`,
        [context.organisationId, clientStrategyId, gap.clientId, strategyId, context.actorId, status, gap.frameworkId, input.requirementId, includeInReport]);
    } else {
      const bespoke = input.bespoke!;
      let notes = "";
      if (input.suggestionId) {
        // The idea it started from must be one shown for this very gap; its words go to the consultant's note, not the client's.
        const idea = (await db.query<{ how: string }>(
          `SELECT how FROM nzi_console.srs_gap_suggestions WHERE organisation_id = $1 AND suggestion_id = $2 AND assessment_id = $3 AND requirement_id = $4 AND status = 'shown'`,
          [context.organisationId, input.suggestionId, input.assessmentId, input.requirementId])).rows[0];
        if (!idea) throw new CommandValidationError([{ field: "suggestionId", code: "NOT_SHOWN", message: "That idea is not shown for this requirement." }]);
        notes = `From an AI idea: ${idea.how}`;
      }
      await db.query(
        `INSERT INTO nzi_console.client_strategies
           (organisation_id, client_strategy_id, client_id, bespoke_title, bespoke_scope, bespoke_category, bespoke_control_level, bespoke_icon_key,
            notes, created_by, status, origin, origin_srs_framework_id, origin_srs_requirement_id, include_in_report)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'target', $8, $9, $10, 'srs_gap', $11, $12, $13)`,
        [context.organisationId, clientStrategyId, gap.clientId, bespoke.title.trim(), bespoke.scope, bespoke.category?.trim() ?? "", bespoke.controlLevel,
          notes, context.actorId, status, gap.frameworkId, input.requirementId, includeInReport]);
    }
    await setStrategyAlignment(db, { organisationId: context.organisationId, clientStrategyId, requirementIds });

    // The link back (S1) — only an assessment still in progress takes one; a completed one is a record.
    let linked = false;
    if (gap.status === "draft") {
      if (gap.itemVersion === null) {
        await db.query(
          `INSERT INTO nzi_console.srs_assessment_items (organisation_id, assessment_id, requirement_id, maturity, linked_action_id, updated_by)
           VALUES ($1, $2, $3, NULL, $4, $5)`,
          [context.organisationId, input.assessmentId, input.requirementId, clientStrategyId, context.actorId]);
      } else {
        await db.query(
          `UPDATE nzi_console.srs_assessment_items SET linked_action_id = $4, version = version + 1, updated_by = $5, updated_at = now()
            WHERE organisation_id = $1 AND assessment_id = $2 AND requirement_id = $3`,
          [context.organisationId, input.assessmentId, input.requirementId, clientStrategyId, context.actorId]);
      }
      linked = true;
    }
    return {
      data: { clientStrategyId, requirementId: input.requirementId, origin: "srs_gap", status, strategyId, fromSuggestionId: input.suggestionId ?? null, linked },
      entityType: "client_strategy", entityId: clientStrategyId, topic: "srs.gap.bridged",
    };
  });
}

export type ExportReportResult = { assessmentId: string; templateKey: string; templateVersion: number; assessedOn: string };

/** The report export, on the record (R8): which completed assessment, which template, which version. Writes nothing else. */
export function exportSrsReport(pool: PoolLike, input: CommandInputMap["srs.report.export"], context: CommandContext): Promise<StoredOutcome<ExportReportResult>> {
  return runPostgresCommand(pool, "srs.report.export", input, context, async (db) => {
    const assessment = (await db.query<{ status: string; assessed_on: Date | string | null }>(
      `SELECT status, assessed_on FROM nzi_console.srs_assessments WHERE organisation_id = $1 AND assessment_id = $2`, [context.organisationId, input.assessmentId])).rows[0];
    if (!assessment) throw new CommandValidationError([{ field: "assessmentId", code: "NOT_FOUND", message: "That assessment does not exist." }]);
    // Completed assessments only (R5): a report is a record of a finding, never of working-out.
    if (assessment.status !== "complete" || assessment.assessed_on === null) {
      throw new CommandValidationError([{ field: "assessmentId", code: "NOT_ASSESSED", message: "A report is made from a completed assessment." }]);
    }
    const template = readinessReportTemplates[input.templateKey]!;
    return {
      data: { assessmentId: input.assessmentId, templateKey: template.key, templateVersion: template.version, assessedOn: londonDayOf(assessment.assessed_on) },
      entityType: "srs_assessment", entityId: input.assessmentId, topic: "srs.report.exported",
    };
  });
}
