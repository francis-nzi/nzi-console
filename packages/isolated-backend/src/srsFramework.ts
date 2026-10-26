// The UK SRS framework as versions an Admin manages (SRS S1, R1).
//
// 0070 published a framework version by migration. Here an Admin starts a draft — a copy of the version in force,
// version + 1 — rewords and reweights it, adds or retires requirements, and publishes it, which supersedes the version
// before. A published version never changes (0187's triggers hold that), so an assessment always means what it meant:
// it stamps the version it was made against. Nothing is deleted; a requirement is retired with `active = false`.
//
// Requirement ids carry over from version to version — the same requirement in a new version — so a strategy's SRS
// alignment, the library's default alignment and a gap's link keep pointing at "S2 M2" as the framework moves.
import { randomUUID } from "node:crypto";
import type { CommandContext, CommandInputMap } from "@nzi/contracts";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

export type SrsFrameworkVersion = {
  frameworkId: string; version: number; label: string; status: "draft" | "active" | "superseded";
  effectiveFrom: string | null; notes: string | null; publishedBy: string; publishedAt: string; requirements: number; assessments: number;
};

/** Every version, newest first, with how many requirements it holds and how many assessments were made against it. */
export async function listSrsFrameworkVersions(db: Queryable): Promise<SrsFrameworkVersion[]> {
  const { rows } = await db.query<{
    framework_id: string; version: number; label: string; status: SrsFrameworkVersion["status"]; effective_from: string | null; notes: string | null;
    published_by: string; published_at: Date | string; requirements: number; assessments: number;
  }>(
    `SELECT f.framework_id, f.version, f.label, f.status, f.effective_from::text, f.notes, f.published_by, f.published_at,
            (SELECT count(*)::int FROM nzi_console.srs_requirements r WHERE (r.organisation_id, r.framework_id) = (f.organisation_id, f.framework_id) AND r.active) AS requirements,
            (SELECT count(*)::int FROM nzi_console.srs_assessments a WHERE (a.organisation_id, a.framework_id) = (f.organisation_id, f.framework_id)) AS assessments
       FROM nzi_console.srs_frameworks f ORDER BY f.version DESC`);
  return rows.map((row) => ({
    frameworkId: row.framework_id, version: row.version, label: row.label, status: row.status, effectiveFrom: row.effective_from, notes: row.notes,
    publishedBy: row.published_by, publishedAt: new Date(row.published_at).toISOString(), requirements: row.requirements, assessments: row.assessments,
  }));
}

/** The draft to edit, locked — refused when the framework is not a draft (a published version is never edited). */
async function lockDraft(db: Queryable, organisationId: string, frameworkId: string): Promise<{ version: number }> {
  const row = (await db.query<{ status: string; version: number }>(
    `SELECT status, version FROM nzi_console.srs_frameworks WHERE organisation_id = $1 AND framework_id = $2 FOR UPDATE`, [organisationId, frameworkId])).rows[0];
  if (!row) throw new CommandValidationError([{ field: "frameworkId", code: "NOT_FOUND", message: "That framework version does not exist." }]);
  if (row.status !== "draft") throw new CommandValidationError([{ field: "frameworkId", code: "PUBLISHED", message: "A published framework version is never edited — start a new version." }]);
  return { version: row.version };
}

export type CreateSrsDraftResult = { frameworkId: string; version: number; copiedFrom: string; requirements: number };

/** Start a new version: a draft copied in full from the version in force — standards, pillars, ladder and requirements. */
export function createSrsFrameworkDraft(pool: PoolLike, input: CommandInputMap["srs.framework.draft.create"], context: CommandContext): Promise<StoredOutcome<CreateSrsDraftResult>> {
  return runPostgresCommand<"srs.framework.draft.create", CreateSrsDraftResult>(pool, "srs.framework.draft.create", input, context, async (db) => {
    const draft = (await db.query<{ framework_id: string }>(`SELECT framework_id FROM nzi_console.srs_frameworks WHERE organisation_id = $1 AND status = 'draft'`, [context.organisationId])).rows[0];
    if (draft) throw new CommandValidationError([{ field: "frameworkId", code: "DRAFT_OPEN", message: "A new version is already in draft — publish it, or carry on editing it." }]);
    const active = (await db.query<{ framework_id: string; version: number; label: string; notes: string | null }>(
      `SELECT framework_id, version, label, notes FROM nzi_console.srs_frameworks WHERE organisation_id = $1 AND status = 'active'`, [context.organisationId])).rows[0];
    if (!active) throw new CommandValidationError([{ field: "frameworkId", code: "NO_FRAMEWORK", message: "No framework is in force to start a new version from." }]);
    const version = (await db.query<{ next: number }>(`SELECT max(version) + 1 AS next FROM nzi_console.srs_frameworks WHERE organisation_id = $1`, [context.organisationId])).rows[0]!.next;
    const frameworkId = `srs-v${version}-${randomUUID().slice(0, 8)}`;
    const copy = [context.organisationId, frameworkId, active.framework_id];
    await db.query(
      `INSERT INTO nzi_console.srs_frameworks (organisation_id, framework_id, version, label, status, notes, published_by)
       VALUES ($1, $2, $3, $4, 'draft', $5, $6)`,
      [context.organisationId, frameworkId, version, input.label?.trim() || `${active.label} — version ${version}`, input.notes?.trim() || active.notes, context.actorId]);
    await db.query(`INSERT INTO nzi_console.srs_standards (organisation_id, framework_id, standard_key, label, description, climate_led, ordering)
      SELECT organisation_id, $2, standard_key, label, description, climate_led, ordering FROM nzi_console.srs_standards WHERE organisation_id = $1 AND framework_id = $3`, copy);
    await db.query(`INSERT INTO nzi_console.srs_pillars (organisation_id, framework_id, pillar_key, label, description, ordering)
      SELECT organisation_id, $2, pillar_key, label, description, ordering FROM nzi_console.srs_pillars WHERE organisation_id = $1 AND framework_id = $3`, copy);
    await db.query(`INSERT INTO nzi_console.srs_maturity_levels (organisation_id, framework_id, level, key, label, definition)
      SELECT organisation_id, $2, level, key, label, definition FROM nzi_console.srs_maturity_levels WHERE organisation_id = $1 AND framework_id = $3`, copy);
    const copied = await db.query(`INSERT INTO nzi_console.srs_requirements
        (organisation_id, framework_id, requirement_id, standard_key, pillar_key, code, title, help_text, weight, source, nzi_source_key, target_maturity, ordering, active)
      SELECT organisation_id, $2, requirement_id, standard_key, pillar_key, code, title, help_text, weight, source, nzi_source_key, target_maturity, ordering, active
        FROM nzi_console.srs_requirements WHERE organisation_id = $1 AND framework_id = $3 RETURNING requirement_id`, copy);
    return {
      data: { frameworkId, version, copiedFrom: active.framework_id, requirements: copied.rows.length },
      entityType: "srs_framework", entityId: frameworkId, topic: "srs.framework.draft_created",
    };
  });
}

export type UpsertSrsRequirementResult = { frameworkId: string; requirementId: string; created: boolean; code: string; weight: number; targetMaturity: number; active: boolean };

/** Add a requirement to the draft, or change one. Its standard, pillar and code are fixed once added. */
export function upsertSrsRequirement(pool: PoolLike, input: CommandInputMap["srs.framework.requirement.upsert"], context: CommandContext): Promise<StoredOutcome<UpsertSrsRequirementResult>> {
  return runPostgresCommand<"srs.framework.requirement.upsert", UpsertSrsRequirementResult>(pool, "srs.framework.requirement.upsert", input, context, async (db) => {
    await lockDraft(db, context.organisationId, input.frameworkId);
    const code = input.code.trim();
    const fields = { title: input.title.trim(), help: input.helpText?.trim() ?? "", weight: input.weight, target: input.targetMaturity, active: input.active };
    if (input.requirementId) {
      const current = (await db.query<{ code: string; standard_key: string; pillar_key: string; weight: string; target_maturity: number; active: boolean; title: string; ordering: number }>(
        `SELECT code, standard_key, pillar_key, weight::text, target_maturity, active, title, ordering FROM nzi_console.srs_requirements
          WHERE organisation_id = $1 AND framework_id = $2 AND requirement_id = $3 FOR UPDATE`, [context.organisationId, input.frameworkId, input.requirementId])).rows[0];
      if (!current) throw new CommandValidationError([{ field: "requirementId", code: "NOT_FOUND", message: "That requirement is not in this draft." }]);
      if (current.code !== code || current.standard_key !== input.standardKey || current.pillar_key !== input.pillarKey) {
        throw new CommandValidationError([{ field: "code", code: "FIXED", message: "A requirement's code, standard and pillar are fixed — retire it and add a new one instead." }]);
      }
      await db.query(
        `UPDATE nzi_console.srs_requirements SET title = $4, help_text = $5, weight = $6, target_maturity = $7, active = $8, ordering = $9
          WHERE organisation_id = $1 AND framework_id = $2 AND requirement_id = $3`,
        [context.organisationId, input.frameworkId, input.requirementId, fields.title, fields.help, fields.weight, fields.target, fields.active, input.ordering ?? current.ordering]);
      return {
        data: { frameworkId: input.frameworkId, requirementId: input.requirementId, created: false, code, weight: fields.weight, targetMaturity: fields.target, active: fields.active },
        entityType: "srs_requirement", entityId: `${input.frameworkId}:${input.requirementId}`, topic: "srs.framework.requirement_upserted",
        before: { title: current.title, weight: Number(current.weight), targetMaturity: current.target_maturity, active: current.active },
      };
    }
    const known = (await db.query<{ standard: boolean; pillar: boolean; clash: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM nzi_console.srs_standards WHERE organisation_id = $1 AND framework_id = $2 AND standard_key = $3) AS standard,
              EXISTS (SELECT 1 FROM nzi_console.srs_pillars WHERE organisation_id = $1 AND framework_id = $2 AND pillar_key = $4) AS pillar,
              EXISTS (SELECT 1 FROM nzi_console.srs_requirements WHERE organisation_id = $1 AND framework_id = $2 AND lower(code) = lower($5)) AS clash`,
      [context.organisationId, input.frameworkId, input.standardKey, input.pillarKey, code])).rows[0]!;
    if (!known.standard) throw new CommandValidationError([{ field: "standardKey", code: "NOT_FOUND", message: "That standard is not in this framework." }]);
    if (!known.pillar) throw new CommandValidationError([{ field: "pillarKey", code: "NOT_FOUND", message: "That pillar is not in this framework." }]);
    if (known.clash) throw new CommandValidationError([{ field: "code", code: "DUPLICATE", message: "A requirement with that code is already in this framework." }]);
    const requirementId = `req-${randomUUID()}`;
    const ordering = input.ordering ?? (await db.query<{ next: number }>(
      `SELECT coalesce(max(ordering), 0) + 1 AS next FROM nzi_console.srs_requirements WHERE organisation_id = $1 AND framework_id = $2 AND standard_key = $3 AND pillar_key = $4`,
      [context.organisationId, input.frameworkId, input.standardKey, input.pillarKey])).rows[0]!.next;
    await db.query(
      `INSERT INTO nzi_console.srs_requirements (organisation_id, framework_id, requirement_id, standard_key, pillar_key, code, title, help_text, weight, source, target_maturity, ordering, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'entered', $10, $11, $12)`,
      [context.organisationId, input.frameworkId, requirementId, input.standardKey, input.pillarKey, code, fields.title, fields.help, fields.weight, fields.target, ordering, fields.active]);
    return {
      data: { frameworkId: input.frameworkId, requirementId, created: true, code, weight: fields.weight, targetMaturity: fields.target, active: fields.active },
      entityType: "srs_requirement", entityId: `${input.frameworkId}:${requirementId}`, topic: "srs.framework.requirement_upserted",
    };
  });
}

export type UpdateSrsMaturityResult = { frameworkId: string; level: number; label: string };

/** Reword a step of the ladder in the draft. The five steps (0–4) are fixed (R5); only their names and definitions change. */
export function updateSrsMaturityLevel(pool: PoolLike, input: CommandInputMap["srs.framework.maturity.update"], context: CommandContext): Promise<StoredOutcome<UpdateSrsMaturityResult>> {
  return runPostgresCommand<"srs.framework.maturity.update", UpdateSrsMaturityResult>(pool, "srs.framework.maturity.update", input, context, async (db) => {
    await lockDraft(db, context.organisationId, input.frameworkId);
    const current = (await db.query<{ label: string; definition: string }>(
      `SELECT label, definition FROM nzi_console.srs_maturity_levels WHERE organisation_id = $1 AND framework_id = $2 AND level = $3 FOR UPDATE`,
      [context.organisationId, input.frameworkId, input.level])).rows[0];
    if (!current) throw new CommandValidationError([{ field: "level", code: "NOT_FOUND", message: "That step is not on this framework's ladder." }]);
    await db.query(`UPDATE nzi_console.srs_maturity_levels SET label = $4, definition = $5 WHERE organisation_id = $1 AND framework_id = $2 AND level = $3`,
      [context.organisationId, input.frameworkId, input.level, input.label.trim(), input.definition.trim()]);
    return {
      data: { frameworkId: input.frameworkId, level: input.level, label: input.label.trim() },
      entityType: "srs_maturity_level", entityId: `${input.frameworkId}:${input.level}`, topic: "srs.framework.maturity_updated",
      before: { label: current.label, definition: current.definition },
    };
  });
}

export type PublishSrsFrameworkResult = { frameworkId: string; version: number; superseded: string | null; libraryAlignmentsCarried: number };

/**
 * Publish the draft: it becomes the version in force, and the one before it is superseded — kept, readable, and still
 * what its assessments were made against. The library's default SRS alignment is carried to the new version for every
 * requirement it still holds, so "Add from library" keeps pre-filling what a strategy advances.
 */
export function publishSrsFramework(pool: PoolLike, input: CommandInputMap["srs.framework.publish"], context: CommandContext): Promise<StoredOutcome<PublishSrsFrameworkResult>> {
  return runPostgresCommand<"srs.framework.publish", PublishSrsFrameworkResult>(pool, "srs.framework.publish", input, context, async (db) => {
    const { version } = await lockDraft(db, context.organisationId, input.frameworkId);
    const active = (await db.query<{ framework_id: string }>(
      `SELECT framework_id FROM nzi_console.srs_frameworks WHERE organisation_id = $1 AND status = 'active' FOR UPDATE`, [context.organisationId])).rows[0] ?? null;
    const requirements = (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nzi_console.srs_requirements WHERE organisation_id = $1 AND framework_id = $2 AND active`, [context.organisationId, input.frameworkId])).rows[0]!.n;
    if (requirements === 0) throw new CommandValidationError([{ field: "frameworkId", code: "EMPTY", message: "A framework with no active requirements cannot be published." }]);
    if (active) await db.query(`UPDATE nzi_console.srs_frameworks SET status = 'superseded' WHERE organisation_id = $1 AND framework_id = $2`, [context.organisationId, active.framework_id]);
    await db.query(
      `UPDATE nzi_console.srs_frameworks SET status = 'active', effective_from = $3, published_by = $4, published_at = now() WHERE organisation_id = $1 AND framework_id = $2`,
      [context.organisationId, input.frameworkId, input.effectiveFrom, context.actorId]);
    const carried = active ? await db.query(
      `INSERT INTO nzi_console.strategy_srs_requirements (organisation_id, strategy_id, framework_id, requirement_id)
       SELECT s.organisation_id, s.strategy_id, $2, s.requirement_id FROM nzi_console.strategy_srs_requirements s
         JOIN nzi_console.srs_requirements r ON (r.organisation_id, r.framework_id, r.requirement_id) = (s.organisation_id, $2, s.requirement_id) AND r.active
        WHERE s.organisation_id = $1 AND s.framework_id = $3
       ON CONFLICT DO NOTHING RETURNING strategy_id`, [context.organisationId, input.frameworkId, active.framework_id]) : { rows: [] };
    return {
      data: { frameworkId: input.frameworkId, version, superseded: active?.framework_id ?? null, libraryAlignmentsCarried: carried.rows.length },
      entityType: "srs_framework", entityId: input.frameworkId, topic: "srs.framework.published",
      before: { status: "draft", superseding: active?.framework_id ?? null },
    };
  });
}
