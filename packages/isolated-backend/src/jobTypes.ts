import { randomUUID } from "node:crypto";
import {
  JOB_TYPE_FAMILIES, jobTypeListSpec, type CommandContext, type CommandInputMap, type JobTypeFamily, type JobTypeFields, type JobTypeListFilterKey,
  type JobTypeListQuery, type JobTypeListSortKey, type ListPage,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { defineListSql, readListPage } from "./listPage";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * Job types (admin Phase C1; docs/design/admin-prototype.html → Job types; ruled `admin-phaseC-plan.md` Q2–Q4, Q8).
 * The services the firm sells, each with one family, a default price ex VAT, estimated hours, a VAT rate and the
 * milestone template a new job of the type starts from. Added, edited, deactivated and reinstated through the command
 * runner (admin.lookups, idempotency, `expectedVersion`, audit with before and after) — never deleted (R3).
 *
 * - **Names are unique per organisation, case-insensitive, inactive types included** (Q2) — so a reinstate never
 *   collides. A code, where given, is unique the same way.
 * - **A type's family is locked while any job uses it** (Q4): a job carries its family, and a type that changed family
 *   under its jobs would describe them wrongly.
 * - **A VAT rate or template must be active to be chosen.** One already on the type stays chosen after it is
 *   deactivated — the same "still resolves" rule every lookup follows — until someone picks another.
 */

// ── The list ───────────────────────────────────────────────────────────────────────────────────────────────────

export type JobTypeProvenance = "v7" | "added";
export type JobTypeRow = {
  jobTypeId: string; name: string; code: string | null; family: JobTypeFamily; description: string | null;
  defaultPriceExVat: number | null; estimatedHours: number | null;
  vatRateId: string | null; vatRateName: string | null; vatRatePct: number | null;
  milestoneTemplateId: string | null; milestoneTemplateName: string | null;
  active: boolean; version: number; provenance: JobTypeProvenance;
  /** Jobs of this type. */
  inUse: number;
  updatedAt: string;
};
export type JobTypePage = ListPage<JobTypeRow, JobTypeListFilterKey, Record<string, never>>;

const inUseSql = (type: string) =>
  `(SELECT count(*) FROM nzi_console.jobs j WHERE (j.organisation_id, j.job_type_id) = (${type}.organisation_id, ${type}.job_type_id))`;

const jobTypeSql = defineListSql<JobTypeListSortKey, JobTypeListFilterKey>({
  base: `SELECT jt.organisation_id, jt.job_type_id, jt.name, jt.code, jt.family, jt.description, jt.default_price_ex_vat, jt.estimated_hours,
      jt.vat_rate_id, vr.name AS vat_rate_name, vr.rate_pct AS vat_rate_pct, jt.milestone_template_id, mt.name AS milestone_template_name,
      jt.active, jt.version, jt.updated_at,
      CASE WHEN jt.active THEN 'active' ELSE 'inactive' END AS status,
      CASE WHEN jt.source_system IS NOT NULL THEN 'v7' ELSE 'added' END AS provenance,
      ${inUseSql("jt")}::int AS in_use
    FROM nzi_console.job_types jt
    LEFT JOIN nzi_console.vat_rates vr ON (vr.organisation_id, vr.vat_rate_id) = (jt.organisation_id, jt.vat_rate_id)
    LEFT JOIN nzi_console.milestone_templates mt ON (mt.organisation_id, mt.template_id) = (jt.organisation_id, jt.milestone_template_id)`,
  search: ["name", "code"],
  filters: {
    family: { kind: "equals", column: "family", facet: { noneLabel: "—", values: JOB_TYPE_FAMILIES } },
    status: { kind: "equals", column: "status", facet: { noneLabel: "—", values: ["active", "inactive"] } },
  },
  sort: {
    name: { column: "name", text: true }, family: { column: "family", text: true }, price: { column: "default_price_ex_vat" },
    hours: { column: "estimated_hours" }, inUse: { column: "in_use" }, status: { column: "status", text: true },
  },
  tiebreak: "job_type_id",
});

const numberOrNull = (value: unknown) => value === null || value === undefined ? null : Number(value);

export async function listJobTypesPage(db: Queryable, query: JobTypeListQuery): Promise<JobTypePage> {
  return readListPage(db, jobTypeSql, jobTypeListSpec, query, {
    mapRow: (row) => ({
      jobTypeId: String(row.job_type_id), name: String(row.name), code: row.code === null ? null : String(row.code),
      family: row.family as JobTypeFamily, description: row.description === null ? null : String(row.description),
      defaultPriceExVat: numberOrNull(row.default_price_ex_vat), estimatedHours: numberOrNull(row.estimated_hours),
      vatRateId: row.vat_rate_id === null ? null : String(row.vat_rate_id), vatRateName: row.vat_rate_name === null ? null : String(row.vat_rate_name),
      vatRatePct: numberOrNull(row.vat_rate_pct),
      milestoneTemplateId: row.milestone_template_id === null ? null : String(row.milestone_template_id),
      milestoneTemplateName: row.milestone_template_name === null ? null : String(row.milestone_template_name),
      active: row.active === true, version: Number(row.version), provenance: row.provenance as JobTypeProvenance,
      inUse: Number(row.in_use), updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    }),
    mapSummary: () => ({}),
  });
}

// ── What the drawer's pickers offer ────────────────────────────────────────────────────────────────────────────

export type JobTypePickers = {
  vatRates: Array<{ vatRateId: string; name: string; ratePct: number; isDefault: boolean; active: boolean }>;
  milestoneTemplates: Array<{ templateId: string; name: string; isDefault: boolean; active: boolean }>;
};

/** Every VAT rate and template, active first — the drawer offers the active ones and still names an inactive one a type holds. */
export async function listJobTypePickers(db: Queryable): Promise<JobTypePickers> {
  const vat = await db.query<{ vat_rate_id: string; name: string; rate_pct: string; is_default: boolean; active: boolean }>(
    `SELECT vat_rate_id, name, rate_pct, is_default, active FROM nzi_console.vat_rates ORDER BY active DESC, is_default DESC, rate_pct DESC, name`);
  const templates = await db.query<{ template_id: string; name: string; is_default: boolean; active: boolean }>(
    `SELECT template_id, name, is_default, active FROM nzi_console.milestone_templates ORDER BY active DESC, is_default DESC, lower(name)`);
  return {
    vatRates: vat.rows.map((row) => ({ vatRateId: row.vat_rate_id, name: row.name, ratePct: Number(row.rate_pct), isDefault: row.is_default, active: row.active })),
    milestoneTemplates: templates.rows.map((row) => ({ templateId: row.template_id, name: row.name, isDefault: row.is_default, active: row.active })),
  };
}

// ── Commands ───────────────────────────────────────────────────────────────────────────────────────────────────

type StoredJobType = {
  name: string; code: string | null; family: JobTypeFamily; description: string | null; default_price_ex_vat: string | null; estimated_hours: string | null;
  vat_rate_id: string | null; milestone_template_id: string | null; active: boolean; version: number;
};

/** What a create or update writes: trimmed, spaces collapsed in the name, blanks as null. */
function cleaned(input: JobTypeFields) {
  const blank = (value: string | null | undefined) => value?.trim() ? value.trim() : null;
  return {
    name: input.name.trim().replace(/\s+/g, " "), code: blank(input.code), family: input.family, description: blank(input.description),
    defaultPriceExVat: input.defaultPriceExVat ?? null, estimatedHours: input.estimatedHours ?? null,
    vatRateId: blank(input.vatRateId), milestoneTemplateId: blank(input.milestoneTemplateId),
  };
}
type Cleaned = ReturnType<typeof cleaned>;

const snapshot = (row: StoredJobType) => ({
  name: row.name, code: row.code, family: row.family, description: row.description,
  defaultPriceExVat: numberOrNull(row.default_price_ex_vat), estimatedHours: numberOrNull(row.estimated_hours),
  vatRateId: row.vat_rate_id, milestoneTemplateId: row.milestone_template_id, active: row.active,
});

/** Q2: a name (and a code) belongs to one type in the organisation, active or not. */
async function assertUnique(db: Queryable, context: CommandContext, fields: Cleaned, exceptId?: string) {
  const { rows } = await db.query<{ name_taken: boolean; code_taken: boolean }>(
    `SELECT bool_or(lower(name) = lower($2)) AS name_taken, bool_or($3::text IS NOT NULL AND lower(code) = lower($3)) AS code_taken
       FROM nzi_console.job_types WHERE organisation_id = $1 AND job_type_id IS DISTINCT FROM $4`,
    [context.organisationId, fields.name, fields.code, exceptId ?? null]);
  const issues = [];
  if (rows[0]?.name_taken) issues.push({ field: "name", code: "DUPLICATE", message: "Another job type — active or not — already has that name." });
  if (rows[0]?.code_taken) issues.push({ field: "code", code: "DUPLICATE", message: "Another job type already has that code." });
  if (issues.length) throw new CommandValidationError(issues);
}

/** A VAT rate or template must exist and be active to be chosen — unless it is the one the type already holds. */
async function assertChoosable(db: Queryable, context: CommandContext, fields: Cleaned, current?: StoredJobType) {
  const issues = [];
  if (fields.vatRateId && fields.vatRateId !== current?.vat_rate_id) {
    const { rows: [rate] } = await db.query<{ active: boolean }>(
      `SELECT active FROM nzi_console.vat_rates WHERE organisation_id = $1 AND vat_rate_id = $2`, [context.organisationId, fields.vatRateId]);
    if (!rate) issues.push({ field: "vatRateId", code: "NOT_FOUND", message: "That VAT rate is not available." });
    else if (!rate.active) issues.push({ field: "vatRateId", code: "INACTIVE", message: "That VAT rate is inactive; choose an active one." });
  }
  if (fields.milestoneTemplateId && fields.milestoneTemplateId !== current?.milestone_template_id) {
    const { rows: [template] } = await db.query<{ active: boolean }>(
      `SELECT active FROM nzi_console.milestone_templates WHERE organisation_id = $1 AND template_id = $2`, [context.organisationId, fields.milestoneTemplateId]);
    if (!template) issues.push({ field: "milestoneTemplateId", code: "NOT_FOUND", message: "That milestone template is not available." });
    else if (!template.active) issues.push({ field: "milestoneTemplateId", code: "INACTIVE", message: "That milestone template is inactive; choose an active one." });
  }
  if (issues.length) throw new CommandValidationError(issues);
}

async function lockJobType(db: Queryable, context: CommandContext, jobTypeId: string, expectedVersion: number): Promise<StoredJobType> {
  const { rows: [row] } = await db.query<StoredJobType>(
    `SELECT name, code, family, description, default_price_ex_vat, estimated_hours, vat_rate_id, milestone_template_id, active, version
       FROM nzi_console.job_types WHERE organisation_id = $1 AND job_type_id = $2 FOR UPDATE`, [context.organisationId, jobTypeId]);
  if (!row) throw new CommandValidationError([{ field: "jobTypeId", code: "NOT_FOUND", message: "That job type is not here." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
  return row;
}

async function jobsUsing(db: Queryable, context: CommandContext, jobTypeId: string): Promise<number> {
  const { rows: [usage] } = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM nzi_console.jobs WHERE organisation_id = $1 AND job_type_id = $2`, [context.organisationId, jobTypeId]);
  return usage?.n ?? 0;
}

/**
 * A command's result is what the type now is — the runner records it as the audit event's after_json, beside the
 * `before` snapshot, so the audit log shows every field before and after.
 */
export type JobTypeResult = Cleaned & { jobTypeId: string; version: number; active: boolean };
const result = (jobTypeId: string, version: number, fields: Cleaned, active: boolean): JobTypeResult => ({ jobTypeId, version, active, ...fields });
const storedFields = (row: StoredJobType): Cleaned => { const { active: _active, ...fields } = snapshot(row); return fields; };

export function createJobType(pool: PoolLike, input: CommandInputMap["job_type.create"], context: CommandContext): Promise<StoredOutcome<JobTypeResult>> {
  return runPostgresCommand(pool, "job_type.create", input, context, async (db) => {
    const fields = cleaned(input);
    await assertUnique(db, context, fields);
    await assertChoosable(db, context, fields);
    const jobTypeId = `job-type:${randomUUID()}`;
    await db.query(
      `INSERT INTO nzi_console.job_types (organisation_id, job_type_id, name, code, family, description, default_price_ex_vat, estimated_hours,
         vat_rate_id, milestone_template_id, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)`,
      [context.organisationId, jobTypeId, fields.name, fields.code, fields.family, fields.description, fields.defaultPriceExVat,
        fields.estimatedHours, fields.vatRateId, fields.milestoneTemplateId, context.actorId]);
    return {
      data: result(jobTypeId, 1, fields, true),
      entityType: "job_type", entityId: jobTypeId, topic: "job_type.created",
    };
  });
}

export function updateJobType(pool: PoolLike, input: CommandInputMap["job_type.update"], context: CommandContext): Promise<StoredOutcome<JobTypeResult>> {
  return runPostgresCommand(pool, "job_type.update", input, context, async (db) => {
    const current = await lockJobType(db, context, input.jobTypeId, input.expectedVersion);
    const fields = cleaned(input);
    if (fields.family !== current.family) {
      const used = await jobsUsing(db, context, input.jobTypeId);
      if (used > 0) {
        throw new CommandValidationError([{ field: "family", code: "LOCKED",
          message: `The family is locked while ${used} job${used === 1 ? " uses" : "s use"} this type — each job carries its family.` }]);
      }
    }
    await assertUnique(db, context, fields, input.jobTypeId);
    await assertChoosable(db, context, fields, current);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.job_types SET name = $3, code = $4, family = $5, description = $6, default_price_ex_vat = $7, estimated_hours = $8,
         vat_rate_id = $9, milestone_template_id = $10, version = version + 1, updated_at = now(), updated_by = $11
        WHERE organisation_id = $1 AND job_type_id = $2 RETURNING version`,
      [context.organisationId, input.jobTypeId, fields.name, fields.code, fields.family, fields.description, fields.defaultPriceExVat,
        fields.estimatedHours, fields.vatRateId, fields.milestoneTemplateId, context.actorId]);
    return {
      data: result(input.jobTypeId, saved!.version, fields, current.active),
      entityType: "job_type", entityId: input.jobTypeId, topic: "job_type.updated",
      before: snapshot(current),
    };
  });
}

export function deactivateJobType(pool: PoolLike, input: CommandInputMap["job_type.deactivate"], context: CommandContext): Promise<StoredOutcome<JobTypeResult & { inUse: number }>> {
  return runPostgresCommand(pool, "job_type.deactivate", input, context, async (db) => {
    const current = await lockJobType(db, context, input.jobTypeId, input.expectedVersion);
    if (!current.active) throw new CommandValidationError([{ field: "jobTypeId", code: "ALREADY_INACTIVE", message: "That job type is already inactive." }]);
    const inUse = await jobsUsing(db, context, input.jobTypeId);
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.job_types SET active = false, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND job_type_id = $2 RETURNING version`, [context.organisationId, input.jobTypeId, context.actorId]);
    return {
      // The jobs still naming it come back, so the person who deactivated it knows what keeps showing it.
      data: { ...result(input.jobTypeId, saved!.version, storedFields(current), false), inUse },
      entityType: "job_type", entityId: input.jobTypeId, topic: "job_type.deactivated",
      before: snapshot(current),
    };
  });
}

export function reinstateJobType(pool: PoolLike, input: CommandInputMap["job_type.reinstate"], context: CommandContext): Promise<StoredOutcome<JobTypeResult>> {
  return runPostgresCommand(pool, "job_type.reinstate", input, context, async (db) => {
    const current = await lockJobType(db, context, input.jobTypeId, input.expectedVersion);
    if (current.active) throw new CommandValidationError([{ field: "jobTypeId", code: "ALREADY_ACTIVE", message: "That job type is already active." }]);
    // No name check: names are unique across active and inactive types alike (Q2), so this one's is still its own.
    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.job_types SET active = true, version = version + 1, updated_at = now(), updated_by = $3
        WHERE organisation_id = $1 AND job_type_id = $2 RETURNING version`, [context.organisationId, input.jobTypeId, context.actorId]);
    return {
      data: result(input.jobTypeId, saved!.version, storedFields(current), true),
      entityType: "job_type", entityId: input.jobTypeId, topic: "job_type.reinstated",
      before: snapshot(current),
    };
  });
}
