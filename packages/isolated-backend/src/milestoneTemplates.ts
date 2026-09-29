import { randomUUID } from "node:crypto";
import {
  MILESTONE_KINDS, type CommandContext, type CommandInputMap, type MilestoneKind, type MilestoneTemplateFields,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * Milestone templates (admin Phase C2; docs/design/admin-prototype.html → Milestone templates; ruled
 * `admin-phaseC-plan.md` R12, Q5, Q6). A template is a default delivery schedule: up to one item per `job_milestones`
 * kind, each with its own label and its own offset in days from a job's anchor. PR 3 generates a new job's milestones
 * from it — only its **included** items (ruled with C1).
 *
 * - **Items are written with the template**, in its command and its version. An item is never deleted (0139): a kind
 *   the template stops scheduling is kept with `included = false`, so its history stays whole.
 * - **Exactly one default per organisation**, and the default cannot be deactivated (Q6). It moves with
 *   `set_default`, in one transaction: the old default is cleared and the new one set, or neither.
 * - **Editing a template never changes an existing job**: jobs copy dates into `job_milestones`.
 */

// ── The read (the design's card grid) ──────────────────────────────────────────────────────────────────────────

export type MilestoneTemplateItem = { kind: MilestoneKind; label: string; daysOffset: number; included: boolean };
export type MilestoneTemplateCard = {
  templateId: string; name: string; description: string | null; isDefault: boolean; active: boolean; version: number;
  provenance: "v7" | "added";
  /** One entry per kind the template has ever carried, in the kinds' order. */
  items: MilestoneTemplateItem[];
  /** Job types that start new jobs from this template (the link is edited on the job type — Q8). */
  jobTypes: Array<{ jobTypeId: string; name: string; active: boolean }>;
  /** Jobs recorded against this template. */
  jobs: number;
  updatedAt: string;
};

const KIND_ORDER = `array_position(ARRAY['data_collection','first_draft','final_report']::text[], i.kind)`;

/** Every template, the default first, then the active ones, by name. A handful per firm — no paging. */
export async function listMilestoneTemplates(db: Queryable): Promise<MilestoneTemplateCard[]> {
  const { rows } = await db.query<{
    template_id: string; name: string; description: string | null; is_default: boolean; active: boolean; version: number; source_system: string | null;
    updated_at: Date | string; jobs: number; job_types: MilestoneTemplateCard["jobTypes"]; items: MilestoneTemplateItem[];
  }>(
    `SELECT mt.template_id, mt.name, mt.description, mt.is_default, mt.active, mt.version, mt.source_system, mt.updated_at,
            (SELECT count(*) FROM nzi_console.jobs j WHERE (j.organisation_id, j.milestone_template_id) = (mt.organisation_id, mt.template_id))::int AS jobs,
            coalesce((SELECT json_agg(json_build_object('jobTypeId', jt.job_type_id, 'name', jt.name, 'active', jt.active) ORDER BY lower(jt.name))
                        FROM nzi_console.job_types jt WHERE (jt.organisation_id, jt.milestone_template_id) = (mt.organisation_id, mt.template_id)), '[]'::json) AS job_types,
            coalesce((SELECT json_agg(json_build_object('kind', i.kind, 'label', i.label, 'daysOffset', i.days_offset, 'included', i.included) ORDER BY ${KIND_ORDER})
                        FROM nzi_console.milestone_template_items i WHERE (i.organisation_id, i.template_id) = (mt.organisation_id, mt.template_id)), '[]'::json) AS items
       FROM nzi_console.milestone_templates mt
      ORDER BY mt.is_default DESC, mt.active DESC, lower(mt.name), mt.template_id`);
  return rows.map((row) => ({
    templateId: row.template_id, name: row.name, description: row.description, isDefault: row.is_default, active: row.active, version: row.version,
    provenance: row.source_system ? "v7" : "added", items: row.items, jobTypes: row.job_types, jobs: row.jobs,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
  }));
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

type StoredTemplate = { name: string; description: string | null; is_default: boolean; active: boolean; version: number };
type StoredItem = { kind: MilestoneKind; label: string; days_offset: number; included: boolean };

/** What a template is, as its audit records it before and after. */
type TemplateSnapshot = { name: string; description: string | null; isDefault: boolean; active: boolean; items: MilestoneTemplateItem[] };
export type MilestoneTemplateResult = TemplateSnapshot & { templateId: string; version: number };

const blank = (value: string | null | undefined) => value?.trim() ? value.trim() : null;
const cleanName = (name: string) => name.trim().replace(/\s+/g, " ");

async function readItems(db: Queryable, context: CommandContext, templateId: string): Promise<StoredItem[]> {
  const { rows } = await db.query<StoredItem>(
    `SELECT i.kind, i.label, i.days_offset, i.included FROM nzi_console.milestone_template_items i
      WHERE i.organisation_id = $1 AND i.template_id = $2 ORDER BY ${KIND_ORDER} FOR UPDATE`, [context.organisationId, templateId]);
  return rows;
}
const itemsOf = (rows: StoredItem[]): MilestoneTemplateItem[] =>
  rows.map((row) => ({ kind: row.kind, label: row.label, daysOffset: row.days_offset, included: row.included }));

async function snapshotOf(db: Queryable, context: CommandContext, templateId: string, template: StoredTemplate): Promise<TemplateSnapshot> {
  return { name: template.name, description: template.description, isDefault: template.is_default, active: template.active,
    items: itemsOf(await readItems(db, context, templateId)) };
}

async function lockTemplate(db: Queryable, context: CommandContext, templateId: string, expectedVersion: number): Promise<StoredTemplate> {
  const { rows: [row] } = await db.query<StoredTemplate>(
    `SELECT name, description, is_default, active, version FROM nzi_console.milestone_templates
      WHERE organisation_id = $1 AND template_id = $2 FOR UPDATE`, [context.organisationId, templateId]);
  if (!row) throw new CommandValidationError([{ field: "templateId", code: "NOT_FOUND", message: "That milestone template is not here." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

/** A name belongs to one template in the organisation, active or not — 0139's index, said as a field error. */
async function assertNameFree(db: Queryable, context: CommandContext, name: string, exceptId?: string) {
  const { rows } = await db.query(
    `SELECT 1 FROM nzi_console.milestone_templates WHERE organisation_id = $1 AND lower(name) = lower($2) AND template_id IS DISTINCT FROM $3`,
    [context.organisationId, name, exceptId ?? null]);
  if (rows[0]) throw new CommandValidationError([{ field: "name", code: "DUPLICATE", message: "Another template — active or not — already has that name." }]);
}

/**
 * Write the schedule: each kind the input names is inserted or updated (its version bumped only when it changes); a
 * kind the template has but the input leaves out is kept and marked not included. Nothing is deleted.
 */
async function writeItems(db: Queryable, context: CommandContext, templateId: string, fields: MilestoneTemplateFields, existing: StoredItem[]) {
  const byKind = new Map(existing.map((item) => [item.kind, item]));
  const named = new Map(fields.items.map((item) => [item.kind, item]));
  for (const kind of MILESTONE_KINDS) {
    const wanted = named.get(kind);
    const current = byKind.get(kind);
    if (wanted) {
      const label = wanted.label.trim().replace(/\s+/g, " ");
      if (!current) {
        await db.query(
          `INSERT INTO nzi_console.milestone_template_items (organisation_id, template_id, kind, label, days_offset, included, created_by, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`, [context.organisationId, templateId, kind, label, wanted.daysOffset, wanted.included, context.actorId]);
      } else if (current.label !== label || current.days_offset !== wanted.daysOffset || current.included !== wanted.included) {
        await db.query(
          `UPDATE nzi_console.milestone_template_items SET label = $4, days_offset = $5, included = $6, version = version + 1, updated_at = now(), updated_by = $7
            WHERE organisation_id = $1 AND template_id = $2 AND kind = $3`, [context.organisationId, templateId, kind, label, wanted.daysOffset, wanted.included, context.actorId]);
      }
    } else if (current?.included) {
      await db.query(
        `UPDATE nzi_console.milestone_template_items SET included = false, version = version + 1, updated_at = now(), updated_by = $4
          WHERE organisation_id = $1 AND template_id = $2 AND kind = $3`, [context.organisationId, templateId, kind, context.actorId]);
    }
  }
}

async function usage(db: Queryable, context: CommandContext, templateId: string): Promise<{ jobs: number; jobTypes: number }> {
  const { rows: [row] } = await db.query<{ jobs: number; job_types: number }>(
    `SELECT (SELECT count(*) FROM nzi_console.jobs WHERE organisation_id = $1 AND milestone_template_id = $2)::int AS jobs,
            (SELECT count(*) FROM nzi_console.job_types WHERE organisation_id = $1 AND milestone_template_id = $2)::int AS job_types`,
    [context.organisationId, templateId]);
  return { jobs: row?.jobs ?? 0, jobTypes: row?.job_types ?? 0 };
}

export function createMilestoneTemplate(pool: PoolLike, input: CommandInputMap["milestone_template.create"], context: CommandContext): Promise<StoredOutcome<MilestoneTemplateResult>> {
  return runPostgresCommand(pool, "milestone_template.create", input, context, async (db) => {
    const name = cleanName(input.name);
    await assertNameFree(db, context, name);
    const templateId = `milestone-template:${randomUUID()}`;
    await db.query(
      `INSERT INTO nzi_console.milestone_templates (organisation_id, template_id, name, description, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)`, [context.organisationId, templateId, name, blank(input.description), context.actorId]);
    await writeItems(db, context, templateId, input, []);
    const template: StoredTemplate = { name, description: blank(input.description), is_default: false, active: true, version: 1 };
    return {
      data: { templateId, version: 1, ...(await snapshotOf(db, context, templateId, template)) },
      entityType: "milestone_template", entityId: templateId, topic: "milestone_template.created",
    };
  });
}

export function updateMilestoneTemplate(pool: PoolLike, input: CommandInputMap["milestone_template.update"], context: CommandContext): Promise<StoredOutcome<MilestoneTemplateResult>> {
  return runPostgresCommand(pool, "milestone_template.update", input, context, async (db) => {
    const current = await lockTemplate(db, context, input.templateId, input.expectedVersion);
    const before = await snapshotOf(db, context, input.templateId, current);
    const name = cleanName(input.name);
    await assertNameFree(db, context, name, input.templateId);
    const { rows: [saved] } = await db.query<StoredTemplate>(
      `UPDATE nzi_console.milestone_templates SET name = $3, description = $4, version = version + 1, updated_at = now(), updated_by = $5
        WHERE organisation_id = $1 AND template_id = $2 RETURNING name, description, is_default, active, version`,
      [context.organisationId, input.templateId, name, blank(input.description), context.actorId]);
    await writeItems(db, context, input.templateId, input, await readItems(db, context, input.templateId));
    return {
      data: { templateId: input.templateId, version: saved!.version, ...(await snapshotOf(db, context, input.templateId, saved!)) },
      entityType: "milestone_template", entityId: input.templateId, topic: "milestone_template.updated", before,
    };
  });
}

export function setDefaultMilestoneTemplate(pool: PoolLike, input: CommandInputMap["milestone_template.set_default"], context: CommandContext):
  Promise<StoredOutcome<MilestoneTemplateResult & { previousDefaultId: string | null }>> {
  return runPostgresCommand(pool, "milestone_template.set_default", input, context, async (db) => {
    const target = await lockTemplate(db, context, input.templateId, input.expectedVersion);
    if (!target.active) throw new CommandValidationError([{ field: "templateId", code: "INACTIVE", message: "An inactive template cannot be the default; reinstate it first." }]);
    if (target.is_default) throw new CommandValidationError([{ field: "templateId", code: "ALREADY_DEFAULT", message: "That template is already the default." }]);
    // One transaction, the old default first: 0139's one-default index never sees two, and never sees the change half made.
    const { rows: [previous] } = await db.query<{ template_id: string }>(
      `UPDATE nzi_console.milestone_templates SET is_default = false, version = version + 1, updated_at = now(), updated_by = $2
        WHERE organisation_id = $1 AND is_default RETURNING template_id`, [context.organisationId, context.actorId]);
    const { rows: [saved] } = await db.query<StoredTemplate>(
      `UPDATE nzi_console.milestone_templates SET is_default = true, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND template_id = $2 RETURNING name, description, is_default, active, version`,
      [context.organisationId, input.templateId, context.actorId]);
    return {
      data: { templateId: input.templateId, version: saved!.version, previousDefaultId: previous?.template_id ?? null, ...(await snapshotOf(db, context, input.templateId, saved!)) },
      entityType: "milestone_template", entityId: input.templateId, topic: "milestone_template.default_set",
      before: { defaultTemplateId: previous?.template_id ?? null },
    };
  });
}

export function deactivateMilestoneTemplate(pool: PoolLike, input: CommandInputMap["milestone_template.deactivate"], context: CommandContext):
  Promise<StoredOutcome<MilestoneTemplateResult & { jobs: number; jobTypes: number }>> {
  return runPostgresCommand(pool, "milestone_template.deactivate", input, context, async (db) => {
    const current = await lockTemplate(db, context, input.templateId, input.expectedVersion);
    if (current.is_default) throw new CommandValidationError([{ field: "templateId", code: "DEFAULT_PROTECTED", message: "The default template cannot be deactivated. Make another template the default first." }]);
    if (!current.active) throw new CommandValidationError([{ field: "templateId", code: "ALREADY_INACTIVE", message: "That template is already inactive." }]);
    const before = await snapshotOf(db, context, input.templateId, current);
    const { rows: [saved] } = await db.query<StoredTemplate>(
      `UPDATE nzi_console.milestone_templates SET active = false, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND template_id = $2 RETURNING name, description, is_default, active, version`,
      [context.organisationId, input.templateId, context.actorId]);
    return {
      // What still names it comes back: those job types and jobs keep showing it, and it is never applied again.
      data: { templateId: input.templateId, version: saved!.version, ...before, active: false, ...(await usage(db, context, input.templateId)) },
      entityType: "milestone_template", entityId: input.templateId, topic: "milestone_template.deactivated", before,
    };
  });
}

export function reinstateMilestoneTemplate(pool: PoolLike, input: CommandInputMap["milestone_template.reinstate"], context: CommandContext): Promise<StoredOutcome<MilestoneTemplateResult>> {
  return runPostgresCommand(pool, "milestone_template.reinstate", input, context, async (db) => {
    const current = await lockTemplate(db, context, input.templateId, input.expectedVersion);
    if (current.active) throw new CommandValidationError([{ field: "templateId", code: "ALREADY_ACTIVE", message: "That template is already active." }]);
    const before = await snapshotOf(db, context, input.templateId, current);
    const { rows: [saved] } = await db.query<StoredTemplate>(
      `UPDATE nzi_console.milestone_templates SET active = true, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND template_id = $2 RETURNING name, description, is_default, active, version`,
      [context.organisationId, input.templateId, context.actorId]);
    return {
      data: { templateId: input.templateId, version: saved!.version, ...before, active: true },
      entityType: "milestone_template", entityId: input.templateId, topic: "milestone_template.reinstated", before,
    };
  });
}
