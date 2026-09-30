import { londonDayOf, MILESTONE_KINDS, todayInLondon, type CommandContext, type CommandInputMap, type MilestoneKind, type RiskLevel } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import { milestoneRisk, riskOf } from "./milestoneRisk";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * The milestone command (PR 3; ruled `pr3-milestone-command-plan.md`, Q7, Q10–Q12, M1–M9, fixes 1–2).
 *
 * A job's three delivery milestones (0137), each now carrying where its date came from (0140's `due_source`):
 * - **template** — generated from a milestone template: at job creation, or by reschedule (which is also "apply a
 *   template" to a job that has none — Q7's per-job path). Only the template's **included** items (C1's ruling). The
 *   date is the job's anchor (the later of its start date and reporting-period start — v7's rule, proven by C5 at 995
 *   of 995) plus the item's offset, and the row records that basis (`due_basis`, M9) for the job page's lineage.
 * - **manual** — set by hand (`job.milestone.set`), or a completion recorded against a kind with no date.
 * - **import** — v7's job plan (the PR 2 backfill).
 *
 * Reschedule moves only template rows that are not completed (Q11). Manual and imported rows never move — that is the
 * per-milestone override (Q10). Nothing is deleted: a kind a new template no longer schedules keeps its row, template
 * and all, with its date and basis cleared (M3, fix 1).
 *
 * Every command writes `updated_by` = the actor, so the PR 2 backfill's R3 rule refuses a job edited here rather than
 * overwrite it (M6).
 */

type Row = {
  kind: MilestoneKind; due_date: string | null; completed_at: Date | string | null; completed_by_user_id: string | null; completed_by_label: string | null;
  due_source: "template" | "manual" | "import"; template_id: string | null; due_basis: DueBasis | null; version: number; source_system: string | null;
};
export type DueBasis = { templateId: string; templateVersion: number; itemLabel: string; anchor: string; anchorFrom: "start_date" | "reporting_period_start"; daysOffset: number };
type Template = { templateId: string; name: string; version: number; active: boolean; items: Array<{ kind: MilestoneKind; label: string; daysOffset: number; included: boolean }> };
type JobHead = { job_id: string; client_id: string; version: number; start_date: string | null; period_start: string | null; milestone_template_id: string | null };

const ROW_COLUMNS = `kind, due_date::text AS due_date, completed_at, completed_by_user_id, completed_by_label, due_source, template_id, due_basis, version, source_system`;

/** The anchor, as v7 computes it: the later of the start date and the reporting-period start; the start when there is no period. */
export function anchorOf(startDate: string | null, periodStart: string | null): { anchor: string; from: DueBasis["anchorFrom"] } | null {
  if (!startDate && !periodStart) return null;
  if (!startDate) return { anchor: periodStart!, from: "reporting_period_start" };
  if (periodStart && periodStart > startDate) return { anchor: periodStart, from: "reporting_period_start" };
  return { anchor: startDate, from: "start_date" };
}

async function readTemplate(db: Queryable, org: string, templateId: string): Promise<Template | null> {
  const { rows: [row] } = await db.query<{ template_id: string; name: string; version: number; active: boolean; items: Template["items"] }>(
    `SELECT t.template_id, t.name, t.version, t.active,
            coalesce((SELECT json_agg(json_build_object('kind', i.kind, 'label', i.label, 'daysOffset', i.days_offset, 'included', i.included))
                        FROM nzi_console.milestone_template_items i WHERE (i.organisation_id, i.template_id) = (t.organisation_id, t.template_id)), '[]'::json) AS items
       FROM nzi_console.milestone_templates t WHERE t.organisation_id = $1 AND t.template_id = $2`, [org, templateId]);
  return row ? { templateId: row.template_id, name: row.name, version: row.version, active: row.active, items: row.items } : null;
}

async function lockRows(db: Queryable, org: string, jobId: string): Promise<Map<MilestoneKind, Row>> {
  const { rows } = await db.query<Row>(`SELECT ${ROW_COLUMNS} FROM nzi_console.job_milestones WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`, [org, jobId]);
  return new Map(rows.map((row) => [row.kind, row]));
}

async function lockJob(db: Queryable, org: string, jobId: string): Promise<JobHead> {
  const { rows: [job] } = await db.query<JobHead>(
    `SELECT job_id, client_id, version, start_date::text AS start_date, reporting_period_start::text AS period_start, milestone_template_id
       FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`, [org, jobId]);
  if (!job) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "That job is not here." }]);
  return job;
}

/** A milestone as the audit and the panel carry it. */
export type MilestoneState = {
  kind: MilestoneKind; dueDate: string | null; completedAt: string | null;
  /** The London day the completion falls on (fix 2) — never the UTC day, which is a day early for a back-dated summer date. */
  completedOn: string | null;
  completedByUserId: string | null; completedByLabel: string | null;
  source: "template" | "manual" | "import"; templateId: string | null; basis: DueBasis | null; version: number;
};
const stateOf = (row: Row): MilestoneState => {
  const completedAt = row.completed_at === null ? null : row.completed_at instanceof Date ? row.completed_at.toISOString() : new Date(row.completed_at).toISOString();
  return {
    kind: row.kind, dueDate: row.due_date, completedAt, completedOn: completedAt === null ? null : londonDayOf(completedAt),
    completedByUserId: row.completed_by_user_id, completedByLabel: row.completed_by_label, source: row.due_source, templateId: row.template_id,
    basis: row.due_basis, version: row.version,
  };
};
async function statesOf(db: Queryable, org: string, jobId: string): Promise<MilestoneState[]> {
  const { rows } = await db.query<Row>(
    `SELECT ${ROW_COLUMNS} FROM nzi_console.job_milestones WHERE organisation_id = $1 AND job_id = $2
      ORDER BY array_position(ARRAY['data_collection','first_draft','final_report']::text[], kind)`, [org, jobId]);
  return rows.map(stateOf);
}

// ── Generation (job.create, and reschedule) ────────────────────────────────────────────────────────────────────

/**
 * Which template a new job is scheduled from: the explicit choice (a string; null is "no milestones"), else the job
 * type's, else the organisation's default. **Active only**: an explicit inactive template is refused; an inactive
 * job-type template or an inactive default is not used, and nothing is generated (the job reads Not set).
 */
export async function templateForNewJob(db: Queryable, org: string, input: { milestoneTemplateId?: string | null; jobTypeTemplateId?: string | null }): Promise<Template | null> {
  if (input.milestoneTemplateId === null) return null;
  if (input.milestoneTemplateId !== undefined) {
    const chosen = await readTemplate(db, org, input.milestoneTemplateId);
    if (!chosen) throw new CommandValidationError([{ field: "milestoneTemplateId", code: "NOT_FOUND", message: "That milestone template is not available." }]);
    if (!chosen.active) throw new CommandValidationError([{ field: "milestoneTemplateId", code: "INACTIVE", message: "That milestone template is inactive; choose an active one." }]);
    return chosen;
  }
  if (input.jobTypeTemplateId) {
    const fromType = await readTemplate(db, org, input.jobTypeTemplateId);
    return fromType?.active ? fromType : null;
  }
  const { rows: [fallback] } = await db.query<{ template_id: string }>(
    `SELECT template_id FROM nzi_console.milestone_templates WHERE organisation_id = $1 AND is_default AND active`, [org]);
  return fallback ? readTemplate(db, org, fallback.template_id) : null;
}

const basisFor = (template: Template, item: Template["items"][number], anchor: NonNullable<ReturnType<typeof anchorOf>>): DueBasis => ({
  templateId: template.templateId, templateVersion: template.version, itemLabel: item.label, anchor: anchor.anchor, anchorFrom: anchor.from, daysOffset: item.daysOffset,
});

/** One template row per included item of the template, dated anchor + offset (in SQL: a date plus whole days). */
export async function generateMilestones(db: Queryable, org: string, actorId: string, job: { jobId: string; startDate: string | null; periodStart: string | null }, template: Template): Promise<MilestoneState[]> {
  const anchor = anchorOf(job.startDate, job.periodStart);
  if (!anchor) return [];
  for (const item of template.items.filter((candidate) => candidate.included)) {
    await db.query(
      `INSERT INTO nzi_console.job_milestones (organisation_id, job_id, kind, due_date, due_source, template_id, due_basis, updated_by)
       VALUES ($1, $2, $3, $4::date + $5::int, 'template', $6, $7::jsonb, $8)`,
      [org, job.jobId, item.kind, anchor.anchor, item.daysOffset, template.templateId, JSON.stringify(basisFor(template, item, anchor)), actorId]);
  }
  return statesOf(db, org, job.jobId);
}

// ── The commands ───────────────────────────────────────────────────────────────────────────────────────────────

export type MilestoneCommandResult = { jobId: string; kind?: MilestoneKind; changed: boolean; milestones: MilestoneState[]; clientId: string };

function checkVersion(row: Row | undefined, expectedVersion: number | undefined) {
  if (!row) return;
  if (expectedVersion === undefined) throw new CommandValidationError([{ field: "expectedVersion", code: "REQUIRED", message: "This milestone exists; say which version you are changing." }]);
  if (row.version !== expectedVersion) throw new VersionConflictError(expectedVersion, row.version);
}

export function setMilestone(pool: PoolLike, input: CommandInputMap["job.milestone.set"], context: CommandContext): Promise<StoredOutcome<MilestoneCommandResult>> {
  return runPostgresCommand(pool, "job.milestone.set", input, context, async (db) => {
    const org = context.organisationId;
    const job = await lockJob(db, org, input.jobId);
    const rows = await lockRows(db, org, input.jobId);
    const row = rows.get(input.kind);
    checkVersion(row, input.expectedVersion);
    if (row?.completed_at) throw new CommandValidationError([{ field: "kind", code: "COMPLETED", message: "This milestone is completed; reopen it before changing its date." }]);
    if (!row && input.dueDate === null) throw new CommandValidationError([{ field: "dueDate", code: "NOTHING_TO_CLEAR", message: "This milestone has no date to clear." }]);
    if (row) {
      await db.query(
        `UPDATE nzi_console.job_milestones SET due_date = $4::date, due_source = 'manual', template_id = NULL, due_basis = NULL,
                version = version + 1, updated_at = now(), updated_by = $5
          WHERE organisation_id = $1 AND job_id = $2 AND kind = $3`, [org, input.jobId, input.kind, input.dueDate, context.actorId]);
    } else {
      await db.query(
        `INSERT INTO nzi_console.job_milestones (organisation_id, job_id, kind, due_date, due_source, updated_by) VALUES ($1, $2, $3, $4::date, 'manual', $5)`,
        [org, input.jobId, input.kind, input.dueDate, context.actorId]);
    }
    return {
      data: { jobId: input.jobId, kind: input.kind, changed: true as boolean, milestones: await statesOf(db, org, input.jobId), clientId: job.client_id },
      entityType: "job_milestone", entityId: `${input.jobId}:${input.kind}`, topic: "job.milestone.set",
      before: row ? { ...stateOf(row) } : { kind: input.kind, absent: true },
    };
  });
}

export function completeMilestone(pool: PoolLike, input: CommandInputMap["job.milestone.complete"], context: CommandContext): Promise<StoredOutcome<MilestoneCommandResult>> {
  return runPostgresCommand(pool, "job.milestone.complete", input, context, async (db) => {
    const org = context.organisationId;
    const today = todayInLondon();
    if (input.completedAt !== undefined && input.completedAt > today) {
      throw new CommandValidationError([{ field: "completedAt", code: "FUTURE", message: `A completion cannot be dated after today (${today}).` }]);
    }
    const job = await lockJob(db, org, input.jobId);
    const rows = await lockRows(db, org, input.jobId);
    const row = rows.get(input.kind);
    if (row?.completed_at) {
      // Idempotent (M5): already completed is returned unchanged, whatever date is passed. Changing a completion date is
      // reopen, then complete — so the audit shows both. The row is not written; the audit records that nothing changed.
      return {
        data: { jobId: input.jobId, kind: input.kind, changed: false as boolean, milestones: await statesOf(db, org, input.jobId), clientId: job.client_id },
        entityType: "job_milestone", entityId: `${input.jobId}:${input.kind}`, topic: "job.milestone.completed", before: stateOf(row),
      };
    }
    checkVersion(row, input.expectedVersion);
    const { rows: [who] } = await db.query<{ display_name: string | null }>(
      `SELECT display_name FROM nzi_console.memberships WHERE organisation_id = $1 AND user_id = $2`, [org, context.actorId]);
    // Fix 2: today → now() (the real moment); an earlier day → the start of that day in London, so it reads back as that day.
    const completedAtSql = `CASE WHEN $5::date IS NULL OR $5::date = $6::date THEN now() ELSE ($5::date::timestamp AT TIME ZONE 'Europe/London') END`;
    const label = who?.display_name?.trim() || null;
    if (row) {
      await db.query(
        `UPDATE nzi_console.job_milestones SET completed_at = ${completedAtSql}, completed_by_user_id = $4, completed_by_label = $7,
                version = version + 1, updated_at = now(), updated_by = $4
          WHERE organisation_id = $1 AND job_id = $2 AND kind = $3`,
        [org, input.jobId, input.kind, context.actorId, input.completedAt ?? null, today, label]);
    } else {
      // Undated completion: a kind with no row records that it happened (Risk ignores it — it has no due date).
      await db.query(
        `INSERT INTO nzi_console.job_milestones (organisation_id, job_id, kind, completed_at, completed_by_user_id, completed_by_label, due_source, updated_by)
         VALUES ($1, $2, $3, ${completedAtSql}, $4, $7, 'manual', $4)`,
        [org, input.jobId, input.kind, context.actorId, input.completedAt ?? null, today, label]);
    }
    return {
      data: { jobId: input.jobId, kind: input.kind, changed: true as boolean, milestones: await statesOf(db, org, input.jobId), clientId: job.client_id },
      entityType: "job_milestone", entityId: `${input.jobId}:${input.kind}`, topic: "job.milestone.completed",
      before: row ? stateOf(row) : { kind: input.kind, absent: true },
    };
  });
}

export function reopenMilestone(pool: PoolLike, input: CommandInputMap["job.milestone.reopen"], context: CommandContext): Promise<StoredOutcome<MilestoneCommandResult>> {
  return runPostgresCommand(pool, "job.milestone.reopen", input, context, async (db) => {
    const org = context.organisationId;
    const job = await lockJob(db, org, input.jobId);
    const row = (await lockRows(db, org, input.jobId)).get(input.kind);
    if (!row?.completed_at) throw new CommandValidationError([{ field: "kind", code: "NOT_COMPLETED", message: "This milestone is not completed." }]);
    checkVersion(row, input.expectedVersion);
    await db.query(
      `UPDATE nzi_console.job_milestones SET completed_at = NULL, completed_by_user_id = NULL, completed_by_label = NULL,
              version = version + 1, updated_at = now(), updated_by = $4
        WHERE organisation_id = $1 AND job_id = $2 AND kind = $3`, [org, input.jobId, input.kind, context.actorId]);
    return {
      data: { jobId: input.jobId, kind: input.kind, changed: true as boolean, milestones: await statesOf(db, org, input.jobId), clientId: job.client_id },
      entityType: "job_milestone", entityId: `${input.jobId}:${input.kind}`, topic: "job.milestone.reopened", before: stateOf(row),
    };
  });
}

export type ReschedulePreview = Array<{ kind: MilestoneKind; action: "generate" | "move" | "keep" | "clear" | "unchanged"; from: string | null; to: string | null; because: string }>;

/**
 * What a reschedule does, kind by kind — shared by the command and the panel's preview, so the preview is the rule.
 * Template rows that are not completed move (or are cleared, if the template no longer schedules their kind); a kind
 * with no row that the template schedules is generated; manual, imported and completed rows are kept.
 */
export function planReschedule(rows: ReadonlyMap<MilestoneKind, Pick<Row, "due_date" | "completed_at" | "due_source">>, template: Template | null,
  anchor: ReturnType<typeof anchorOf>): ReschedulePreview {
  return MILESTONE_KINDS.map((kind) => {
    const row = rows.get(kind);
    const item = template?.items.find((candidate) => candidate.kind === kind && candidate.included);
    const to = item && anchor ? addDays(anchor.anchor, item.daysOffset) : null;
    if (row && row.completed_at) return { kind, action: "keep", from: row.due_date, to: row.due_date, because: "completed — never moved" };
    if (row && row.due_source !== "template") return { kind, action: "keep", from: row.due_date, to: row.due_date, because: row.due_source === "manual" ? "set by hand — never moved" : "from v7 — never moved" };
    if (!row) return to ? { kind, action: "generate", from: null, to, because: "scheduled by the template" } : { kind, action: "unchanged", from: null, to: null, because: "not scheduled" };
    if (!to) return row.due_date === null ? { kind, action: "unchanged", from: null, to: null, because: "not scheduled" } : { kind, action: "clear", from: row.due_date, to: null, because: "the template no longer schedules it" };
    return row.due_date === to ? { kind, action: "unchanged", from: to, to, because: "already on the template's date" } : { kind, action: "move", from: row.due_date, to, because: "recomputed from the template" };
  });
}
function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const moved = new Date(Date.UTC(y, m - 1, d + days));
  return `${moved.getUTCFullYear()}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}-${String(moved.getUTCDate()).padStart(2, "0")}`;
}

export function rescheduleMilestones(pool: PoolLike, input: CommandInputMap["job.milestone.reschedule"], context: CommandContext): Promise<StoredOutcome<MilestoneCommandResult & { preview: ReschedulePreview }>> {
  return runPostgresCommand(pool, "job.milestone.reschedule", input, context, async (db) => {
    const org = context.organisationId;
    const job = await lockJob(db, org, input.jobId);
    if (job.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, job.version);
    const templateId = input.milestoneTemplateId === undefined ? job.milestone_template_id : input.milestoneTemplateId;
    const template = templateId ? await readTemplate(db, org, templateId) : null;
    if (templateId && !template) throw new CommandValidationError([{ field: "milestoneTemplateId", code: "NOT_FOUND", message: "That milestone template is not available." }]);
    if (template && !template.active) throw new CommandValidationError([{ field: "milestoneTemplateId", code: "INACTIVE", message: "That milestone template is inactive; choose an active one." }]);
    const before = await statesOf(db, org, input.jobId);
    const rows = await lockRows(db, org, input.jobId);
    const anchor = anchorOf(job.start_date, job.period_start);
    const preview = planReschedule(rows, template, anchor);

    if (templateId !== job.milestone_template_id) {
      await db.query(`UPDATE nzi_console.jobs SET milestone_template_id = $3, version = version + 1, updated_at = now() WHERE organisation_id = $1 AND job_id = $2`,
        [org, input.jobId, templateId]);
    }
    for (const step of preview) {
      const item = template?.items.find((candidate) => candidate.kind === step.kind && candidate.included);
      if (step.action === "generate" || step.action === "move") {
        const basis = JSON.stringify(basisFor(template!, item!, anchor!));
        if (step.action === "generate") {
          await db.query(
            `INSERT INTO nzi_console.job_milestones (organisation_id, job_id, kind, due_date, due_source, template_id, due_basis, updated_by)
             VALUES ($1, $2, $3, $4::date, 'template', $5, $6::jsonb, $7)`, [org, input.jobId, step.kind, step.to, template!.templateId, basis, context.actorId]);
        } else {
          await db.query(
            `UPDATE nzi_console.job_milestones SET due_date = $4::date, template_id = $5, due_basis = $6::jsonb, version = version + 1, updated_at = now(), updated_by = $7
              WHERE organisation_id = $1 AND job_id = $2 AND kind = $3`, [org, input.jobId, step.kind, step.to, template!.templateId, basis, context.actorId]);
        }
      } else if (step.action === "clear") {
        // M3, fix 1: kept as the template's now-empty slot — its template_id stays; its date and basis go; not made manual.
        await db.query(
          `UPDATE nzi_console.job_milestones SET due_date = NULL, due_basis = NULL, template_id = coalesce($4, template_id), version = version + 1, updated_at = now(), updated_by = $5
            WHERE organisation_id = $1 AND job_id = $2 AND kind = $3`, [org, input.jobId, step.kind, template?.templateId ?? null, context.actorId]);
      } else if (step.action === "unchanged" && rows.get(step.kind)?.due_source === "template" && template && rows.get(step.kind)!.due_date !== null) {
        // Same date, possibly a different template: the row's basis follows the template now in force.
        await db.query(
          `UPDATE nzi_console.job_milestones SET template_id = $4, due_basis = $5::jsonb WHERE organisation_id = $1 AND job_id = $2 AND kind = $3 AND template_id IS DISTINCT FROM $4`,
          [org, input.jobId, step.kind, template.templateId, JSON.stringify(basisFor(template, item!, anchor!))]);
      }
    }
    return {
      data: { jobId: input.jobId, changed: preview.some((step) => step.action !== "keep" && step.action !== "unchanged") || templateId !== job.milestone_template_id,
        milestones: await statesOf(db, org, input.jobId), clientId: job.client_id, preview },
      entityType: "job", entityId: input.jobId, topic: "job.milestone.rescheduled", before: { milestoneTemplateId: job.milestone_template_id, milestones: before },
    };
  });
}

// ── The create form's options ─────────────────────────────────────────────────────────────────────────────────

export type JobSetupOptions = {
  jobTypes: Array<{ jobTypeId: string; name: string; family: string; milestoneTemplateId: string | null; milestoneTemplateName: string | null; milestoneTemplateActive: boolean | null }>;
  templates: Array<{ templateId: string; name: string; isDefault: boolean }>;
};

/** Active job types (with the template each names) and active templates, the default first — what job.create accepts. */
export async function listJobSetupOptions(db: Queryable): Promise<JobSetupOptions> {
  const types = await db.query<{ job_type_id: string; name: string; family: string; milestone_template_id: string | null; template_name: string | null; template_active: boolean | null }>(
    `SELECT jt.job_type_id, jt.name, jt.family, jt.milestone_template_id, mt.name AS template_name, mt.active AS template_active
       FROM nzi_console.job_types jt LEFT JOIN nzi_console.milestone_templates mt ON (mt.organisation_id, mt.template_id) = (jt.organisation_id, jt.milestone_template_id)
      WHERE jt.active ORDER BY lower(jt.name)`);
  const templates = await db.query<{ template_id: string; name: string; is_default: boolean }>(
    `SELECT template_id, name, is_default FROM nzi_console.milestone_templates WHERE active ORDER BY is_default DESC, lower(name)`);
  return {
    jobTypes: types.rows.map((row) => ({ jobTypeId: row.job_type_id, name: row.name, family: row.family, milestoneTemplateId: row.milestone_template_id,
      milestoneTemplateName: row.template_name, milestoneTemplateActive: row.template_active })),
    templates: templates.rows.map((row) => ({ templateId: row.template_id, name: row.name, isDefault: row.is_default })),
  };
}

// ── The read (the job page's panel) ────────────────────────────────────────────────────────────────────────────

export type JobMilestonesView = {
  jobId: string; jobVersion: number; anchor: ReturnType<typeof anchorOf>;
  template: { templateId: string; name: string; active: boolean } | null;
  milestones: Array<MilestoneState & { risk: Exclude<RiskLevel, "Not set"> | null }>;
  risk: RiskLevel;
  /** Active templates a reschedule may choose, the default first, and what a reschedule would do with each (and with none). */
  templates: Array<{ templateId: string; name: string; isDefault: boolean; preview: ReschedulePreview }>;
  previewWithout: ReschedulePreview;
};

export async function readJobMilestones(db: Queryable, jobId: string, operatingDay: string = todayInLondon()): Promise<JobMilestonesView | null> {
  const { rows: [job] } = await db.query<JobHead & { organisation_id: string }>(
    `SELECT organisation_id, job_id, client_id, version, start_date::text AS start_date, reporting_period_start::text AS period_start, milestone_template_id
       FROM nzi_console.jobs WHERE job_id = $1`, [jobId]);
  if (!job) return null;
  const org = job.organisation_id;
  const states = await statesOf(db, org, jobId);
  const rows = new Map(states.map((state) => [state.kind, { due_date: state.dueDate, completed_at: state.completedAt, due_source: state.source }]));
  const anchor = anchorOf(job.start_date, job.period_start);
  const current = job.milestone_template_id ? await readTemplate(db, org, job.milestone_template_id) : null;
  const { rows: active } = await db.query<{ template_id: string; is_default: boolean }>(
    `SELECT template_id, is_default FROM nzi_console.milestone_templates WHERE organisation_id = $1 AND active ORDER BY is_default DESC, lower(name)`, [org]);
  const templates = [];
  for (const candidate of active) {
    const template = (await readTemplate(db, org, candidate.template_id))!;
    templates.push({ templateId: template.templateId, name: template.name, isDefault: candidate.is_default, preview: planReschedule(rows, template, anchor) });
  }
  return {
    jobId, jobVersion: job.version, anchor,
    template: current ? { templateId: current.templateId, name: current.name, active: current.active } : null,
    milestones: states.map((state) => ({ ...state, risk: milestoneRisk({ dueDate: state.dueDate, completedAt: state.completedAt }, operatingDay) })),
    risk: riskOf(states.map((state) => ({ dueDate: state.dueDate, completedAt: state.completedAt })), operatingDay),
    templates, previewWithout: planReschedule(rows, null, anchor),
  };
}
