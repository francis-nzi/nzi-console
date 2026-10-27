// Data entry D2 (R5): AI suggestions of the category for a spend line the client's map does not know — on S3's terms. The AI
// suggests; a person decides. This module asks a model (outside any transaction), grounds the reply, and stores it labelled and
// pending; only a person's confirmation — or a move at review that uses it — writes the map (`learnSpendAllocation`).
import { randomUUID } from "node:crypto";
import {
  groundSpendSuggestion, normaliseDescription, normaliseGlCode, routeSpendLine, SPEND_SUGGESTION_SCHEMA, spendAllocationKey, spendSuggestionInputFor,
  spendSuggestionPrompt, type CommandContext, type CommandInputMap, type SpendAllocationKeyKind, type SpendSuggestionInput,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { CommandValidationError, requireCrpJob, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { Queryable, PoolLike } from "./postgres";
import { learnSpendAllocation } from "./spendAllocation";
import { activeSpendAllocations, clientOfJob } from "./spendAllocationReads";
import { anthropicStructuredModel, srsPromptSha256, type SrsSuggestionModel } from "./srsSuggestions";

export type SpendSuggestionModel = SrsSuggestionModel;

/** The real model: S3's adapter, with this task's schema. The key is passed in at the composition edge. */
export const anthropicSpendSuggestionModel = (config: { apiKey: string; model?: string; client?: Parameters<typeof anthropicStructuredModel>[0]["client"] }) =>
  anthropicStructuredModel({ ...config, schema: SPEND_SUGGESTION_SCHEMA as unknown as Record<string, unknown>, unreadable: { categoryCode: "none", reason: "" } });

/**
 * What may be asked about one line on one job (read-only): the client, the line's key, and the input the model will be given —
 * refused for a line the client's map already routes (the map has the answer; the AI is for the unmapped only).
 */
export async function spendSuggestionRequest(db: Queryable, organisationId: string, jobId: string, line: { glCode?: string | null; description?: string | null }): Promise<{
  clientId: string; key: { kind: SpendAllocationKeyKind; key: string; display: string }; input: SpendSuggestionInput;
}> {
  const clientId = await clientOfJob(db, organisationId, jobId);
  if (!clientId) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "That job was not found." }]);
  const key = spendAllocationKey(line);
  const client = (await db.query<{ name: string }>(`SELECT name FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [organisationId, clientId])).rows[0];
  // The client's own name never leaves with the description (R5).
  const input = spendSuggestionInputFor(line, client ? [client.name] : []);
  if (!key || !input) throw new CommandValidationError([{ field: "glCode", code: "NOTHING_TO_ASK", message: "A line needs a GL code or a description to be suggested a category." }]);
  const routed = routeSpendLine(await activeSpendAllocations(db, organisationId, clientId), line);
  if (routed.by !== "residual") throw new CommandValidationError([{ field: "glCode", code: "ALREADY_MAPPED", message: "This client's map already routes that line — change the map entry rather than asking for a suggestion." }]);
  const display = (key.kind === "gl" ? line.glCode : line.description)!.trim().slice(0, 200);
  return { clientId, key: { ...key, display }, input };
}

export type SpendSuggestionRun = { categoryCode: string; reason: string } | null;

/** Ask the model about one line and keep the answer only if it is grounded. Pure but for the model call. */
export async function generateSpendSuggestion(model: SpendSuggestionModel, input: SpendSuggestionInput): Promise<{ suggestion: SpendSuggestionRun; dropped: string | null; model: string; promptSha256: string }> {
  const prompt = spendSuggestionPrompt(input);
  const promptSha256 = srsPromptSha256(prompt);
  const reply = await model.suggest(prompt);
  if (reply.kind === "refused") return { suggestion: null, dropped: "declined by the model", model: model.id, promptSha256 };
  const grounded = groundSpendSuggestion(reply.body);
  return grounded.ok
    ? { suggestion: { categoryCode: grounded.categoryCode, reason: grounded.reason }, dropped: null, model: model.id, promptSha256 }
    : { suggestion: null, dropped: grounded.reason, model: model.id, promptSha256 };
}

export type SpendSuggestionRecorded = { suggestionId: string; keyKind: SpendAllocationKeyKind; categoryCode: string; model: string; promptSha256: string; version: number };

/**
 * Store a grounded suggestion, labelled and pending. The command's data — and so the audit event's after_json — names the request
 * by reference: the model, the prompt's SHA-256, the suggested category. Never the description or the reason.
 */
export function recordSpendAllocationSuggestion(pool: PoolLike, input: CommandInputMap["spend_allocation.suggestion.record"], context: CommandContext): Promise<StoredOutcome<SpendSuggestionRecorded>> {
  return runPostgresCommand(pool, "spend_allocation.suggestion.record", input, context, async (db) => {
    await requireCrpJob(db, context.organisationId, input.jobId);
    const clientId = (await clientOfJob(db, context.organisationId, input.jobId))!;
    const matchKey = input.keyKind === "gl" ? normaliseGlCode(input.key) : normaliseDescription(input.key);
    if (!matchKey) throw new CommandValidationError([{ field: "key", code: "INVALID", message: "That key has nothing left to match on once normalised." }]);
    const suggestionId = randomUUID();
    await db.query(
      `INSERT INTO nzi_console.spend_allocation_suggestions (organisation_id, suggestion_id, client_id, job_id, key_kind, match_key, display_key,
         suggested_category_code, reason, model, prompt_sha256, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [context.organisationId, suggestionId, clientId, input.jobId, input.keyKind, matchKey, input.key.trim().slice(0, 200), input.categoryCode,
        input.reason.trim(), input.model, input.promptSha256, context.actorId]);
    return { data: { suggestionId, keyKind: input.keyKind, categoryCode: input.categoryCode, model: input.model, promptSha256: input.promptSha256, version: 1 },
      entityType: "spend_allocation_suggestion", entityId: suggestionId, topic: "spend_allocation.suggestion.recorded" };
  });
}

type SuggestionRow = { suggestion_id: string; client_id: string; job_id: string; key_kind: SpendAllocationKeyKind; match_key: string; display_key: string;
  suggested_category_code: string; status: string; version: number };

export async function lockSuggestion(db: Queryable, organisationId: string, jobId: string, suggestionId: string, expectedVersion: number | null): Promise<SuggestionRow> {
  const { rows: [row] } = await db.query<SuggestionRow>(
    `SELECT suggestion_id, client_id, job_id, key_kind, match_key, display_key, suggested_category_code, status, version
       FROM nzi_console.spend_allocation_suggestions WHERE organisation_id = $1 AND suggestion_id = $2 FOR UPDATE`, [organisationId, suggestionId]);
  const clientId = await clientOfJob(db, organisationId, jobId);
  if (!row || row.client_id !== clientId) throw new CommandValidationError([{ field: "suggestionId", code: "NOT_FOUND", message: "That suggestion was not found for this job's client." }]);
  if (expectedVersion !== null && row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  if (row.status !== "suggested") throw new CommandValidationError([{ field: "suggestionId", code: "DECIDED", message: "That suggestion has already been confirmed or dismissed." }]);
  return row;
}

/** Mark a suggestion confirmed against the map entry the person's decision wrote, in the caller's transaction. */
export async function markSuggestionConfirmed(db: Queryable, organisationId: string, suggestionId: string, categoryCode: string, allocationId: string, actorId: string): Promise<number> {
  const { rows: [saved] } = await db.query<{ version: number }>(
    `UPDATE nzi_console.spend_allocation_suggestions SET status = 'confirmed', confirmed_category_code = $3, allocation_id = $4, decided_by = $5, decided_at = now(), version = version + 1
      WHERE organisation_id = $1 AND suggestion_id = $2 RETURNING version`, [organisationId, suggestionId, categoryCode, allocationId, actorId]);
  return saved!.version;
}

export type SpendSuggestionConfirmed = { suggestionId: string; version: number; categoryCode: string; allocation: { allocationId: string; created: boolean; version: number } };

/**
 * R5: a person confirms a suggestion — as suggested, or with the category they chose instead — and the client's map gets the entry
 * (`suggestion-confirmed`). This, not the model, is what writes the map.
 */
export function confirmSpendAllocationSuggestion(pool: PoolLike, input: CommandInputMap["spend_allocation.suggestion.confirm"], context: CommandContext): Promise<StoredOutcome<SpendSuggestionConfirmed>> {
  return runPostgresCommand(pool, "spend_allocation.suggestion.confirm", input, context, async (db) => {
    await requireCrpJob(db, context.organisationId, input.jobId);
    const row = await lockSuggestion(db, context.organisationId, input.jobId, input.suggestionId, input.expectedVersion);
    const line = row.key_kind === "gl" ? { glCode: row.display_key } : { description: row.display_key };
    const learnt = (await learnSpendAllocation(db, context, row.client_id, line, input.categoryCode, "suggestion-confirmed"))!;
    const version = await markSuggestionConfirmed(db, context.organisationId, input.suggestionId, input.categoryCode, learnt.allocationId, context.actorId);
    return { data: { suggestionId: input.suggestionId, version, categoryCode: input.categoryCode, allocation: { allocationId: learnt.allocationId, created: learnt.created, version: learnt.version } },
      entityType: "spend_allocation_suggestion", entityId: input.suggestionId, topic: "spend_allocation.suggestion.confirmed",
      before: { status: "suggested", suggestedCategoryCode: row.suggested_category_code } };
  });
}

export function dismissSpendAllocationSuggestion(pool: PoolLike, input: CommandInputMap["spend_allocation.suggestion.dismiss"], context: CommandContext): Promise<StoredOutcome<{ suggestionId: string; version: number }>> {
  return runPostgresCommand(pool, "spend_allocation.suggestion.dismiss", input, context, async (db) => {
    await requireCrpJob(db, context.organisationId, input.jobId);
    await lockSuggestion(db, context.organisationId, input.jobId, input.suggestionId, input.expectedVersion);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.spend_allocation_suggestions SET status = 'dismissed', decided_by = $3, decided_at = now(), version = version + 1
        WHERE organisation_id = $1 AND suggestion_id = $2 RETURNING version`, [context.organisationId, input.suggestionId, context.actorId]);
    return { data: { suggestionId: input.suggestionId, version: saved!.version }, entityType: "spend_allocation_suggestion", entityId: input.suggestionId,
      topic: "spend_allocation.suggestion.dismissed", before: { status: "suggested" } };
  });
}
