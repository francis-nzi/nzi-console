import {
  MESSAGE_TEMPLATE_REGISTRY, messageTemplateDefinition,
  type CommandContext, type CommandInputMap, type MessageContent, type MessageTemplateDefinition,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * Message templates (admin Phase F1; ruled `phaseF-comms-crm-plan.md`, F-Q2/F-Q3/F-Q7): 0149's `message_templates`,
 * written through the command runner (admin.templates) over the code registry of keys.
 *
 * - **A key from the registry only (F-Q3)**, set once; the command refuses one no send-site uses.
 * - **Declared tokens only (F-Q2)** — checked by the command's validation, as on the screen.
 * - **What is sent** is the organisation's active template, else the registry's built-in wording
 *   (`readActiveMessageTemplate` + `messageContentFor`). Deactivating is going back to the built-in; nothing is deleted.
 * - **Audited in full**: a template is wording, not personal data or an amount, so the audit records before and after.
 */

export type MessageTemplateProvenance = "v7" | "added";
export type MessageTemplateRow = {
  key: string; label: string; purpose: string; sendSite: string; channel: string;
  tokens: MessageTemplateDefinition["tokens"];
  builtIn: MessageContent;
  /** The organisation's own wording, when it has saved some — active or not. */
  saved: (MessageContent & { active: boolean; version: number; provenance: MessageTemplateProvenance; updatedAt: string; updatedBy: string }) | null;
  /** Which wording a send uses today. */
  inUse: "own" | "built-in";
};

const iso = (date: unknown) => date instanceof Date ? date.toISOString() : String(date);
type Stored = { template_key: string; subject: string; body: string; active: boolean; version: number; source_system: string | null; updated_at: unknown; updated_by: string };

/** Every message the console sends, in registry order, with the organisation's own wording beside the built-in. */
export async function listMessageTemplates(db: Queryable): Promise<MessageTemplateRow[]> {
  const { rows } = await db.query<Stored>(
    `SELECT template_key, subject, body, active, version, source_system, updated_at, updated_by FROM nzi_console.message_templates`);
  return MESSAGE_TEMPLATE_REGISTRY.map((definition) => {
    const row = rows.find((candidate) => candidate.template_key === definition.key);
    return {
      key: definition.key, label: definition.label, purpose: definition.purpose, sendSite: definition.sendSite, channel: definition.channel,
      tokens: definition.tokens, builtIn: definition.builtIn,
      saved: row ? { subject: row.subject, body: row.body, active: row.active, version: row.version, provenance: row.source_system ? "v7" : "added",
        updatedAt: iso(row.updated_at), updatedBy: row.updated_by } : null,
      inUse: row?.active ? "own" : "built-in",
    };
  });
}

/** The organisation's active wording for a key, or null — in which case the send uses the built-in (`messageContentFor`). */
export async function readActiveMessageTemplate(db: Queryable, templateKey: string): Promise<MessageContent | null> {
  const { rows: [row] } = await db.query<{ subject: string; body: string }>(
    `SELECT subject, body FROM nzi_console.message_templates WHERE template_key = $1 AND active`, [templateKey]);
  return row ? { subject: row.subject, body: row.body } : null;
}

// ── Commands (admin.templates) ───────────────────────────────────────────────────────────────────────────────────────

type Snapshot = { templateKey: string; subject: string; body: string; active: boolean };
export type MessageTemplateResult = Snapshot & { version: number };
const RETURNING = "RETURNING template_key, subject, body, active, version";
const snapshot = (row: { template_key: string; subject: string; body: string; active: boolean }): Snapshot =>
  ({ templateKey: row.template_key, subject: row.subject, body: row.body, active: row.active });

async function lock(db: Queryable, context: CommandContext, templateKey: string, expectedVersion: number) {
  const { rows: [row] } = await db.query<{ template_key: string; subject: string; body: string; active: boolean; version: number }>(
    `SELECT template_key, subject, body, active, version FROM nzi_console.message_templates WHERE organisation_id = $1 AND template_key = $2 FOR UPDATE`,
    [context.organisationId, templateKey]);
  if (!row) throw new CommandValidationError([{ field: "templateKey", code: "NOT_FOUND", message: "This organisation has no wording of its own for that message yet." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

export function createMessageTemplate(pool: PoolLike, input: CommandInputMap["message_template.create"], context: CommandContext): Promise<StoredOutcome<MessageTemplateResult>> {
  return runPostgresCommand(pool, "message_template.create", input, context, async (db) => {
    const definition = messageTemplateDefinition(input.templateKey)!;
    const { rows: [held] } = await db.query<{ held: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM nzi_console.message_templates WHERE organisation_id = $1 AND template_key = $2) AS held`, [context.organisationId, input.templateKey]);
    if (held?.held) throw new CommandValidationError([{ field: "templateKey", code: "DUPLICATE", message: "This organisation already has its own wording for that message — edit it, or reinstate it." }]);
    const { rows: [saved] } = await db.query<{ template_key: string; subject: string; body: string; active: boolean; version: number }>(
      `INSERT INTO nzi_console.message_templates (organisation_id, template_key, channel, subject, body, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $6) ${RETURNING}`,
      [context.organisationId, input.templateKey, definition.channel, input.subject, input.body, context.actorId]);
    return { data: { ...snapshot(saved!), version: saved!.version }, entityType: "message_template", entityId: input.templateKey, topic: "message_template.created" };
  });
}

export function updateMessageTemplate(pool: PoolLike, input: CommandInputMap["message_template.update"], context: CommandContext): Promise<StoredOutcome<MessageTemplateResult>> {
  return runPostgresCommand(pool, "message_template.update", input, context, async (db) => {
    const current = await lock(db, context, input.templateKey, input.expectedVersion);
    if (current.subject === input.subject && current.body === input.body) throw new CommandValidationError([{ field: "body", code: "UNCHANGED", message: "That is the wording it already holds." }]);
    const { rows: [saved] } = await db.query<{ template_key: string; subject: string; body: string; active: boolean; version: number }>(
      `UPDATE nzi_console.message_templates SET subject = $3, body = $4, version = version + 1, updated_at = now(), updated_by = $5
        WHERE organisation_id = $1 AND template_key = $2 ${RETURNING}`,
      [context.organisationId, input.templateKey, input.subject, input.body, context.actorId]);
    return { data: { ...snapshot(saved!), version: saved!.version }, entityType: "message_template", entityId: input.templateKey,
      topic: "message_template.updated", before: snapshot(current) };
  });
}

function setActive(key: "message_template.deactivate" | "message_template.reinstate", active: boolean) {
  return (pool: PoolLike, input: CommandInputMap[typeof key], context: CommandContext): Promise<StoredOutcome<MessageTemplateResult>> =>
    runPostgresCommand(pool, key, input, context, async (db) => {
      const current = await lock(db, context, input.templateKey, input.expectedVersion);
      if (current.active === active) throw new CommandValidationError([{ field: "templateKey", code: active ? "ALREADY_ACTIVE" : "ALREADY_INACTIVE", message: active ? "That wording is already in use." : "That message already uses its built-in wording." }]);
      const { rows: [saved] } = await db.query<{ template_key: string; subject: string; body: string; active: boolean; version: number }>(
        `UPDATE nzi_console.message_templates SET active = $3, version = version + 1, updated_at = now(), updated_by = $4
          WHERE organisation_id = $1 AND template_key = $2 ${RETURNING}`,
        [context.organisationId, input.templateKey, active, context.actorId]);
      return { data: { ...snapshot(saved!), version: saved!.version }, entityType: "message_template", entityId: input.templateKey,
        topic: active ? "message_template.reinstated" : "message_template.deactivated", before: snapshot(current) };
    });
}
/** Back to the built-in wording; the organisation's own is kept, to reinstate. */
export const deactivateMessageTemplate = setActive("message_template.deactivate", false);
export const reinstateMessageTemplate = setActive("message_template.reinstate", true);
