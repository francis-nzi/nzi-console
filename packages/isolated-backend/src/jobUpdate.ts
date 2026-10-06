import {
  anchorOf, familyHasReportingPeriod, jobDateIssues, planReschedule, reportingYearForPeriod, type CommandContext, type CommandInputMap, type ReschedulePreview,
  type WorkflowJobFamily,
} from "@nzi/contracts";
import { automaticDatasetsFor, datasetCoverageWarnings, jobCountryCode, NEW_JOB_COUNTRY, selectAutomaticDatasets, type ReportingWindow } from "./datasetSelection";
import { VersionConflictError } from "./errors";
import { applyReschedule, milestoneStatesOf, readScheduleRows, templateForReschedule, type MilestoneState, type MilestoneTemplateWithItems } from "./milestoneCommands";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import type { PoolLike, Queryable } from "./postgres";

/**
 * job.update — edit a job's start date, reporting period and milestone template (ruled `job-update-plan.md`, J1–J6).
 *
 * - **J1 (option b):** a reporting-period move is refused once the job holds period-bound data (`PERIOD_HAS_DATA`,
 *   naming each table and its rows). Which tables are period-bound is said once, below, and checked **fail-closed**:
 *   every table with a foreign key to `jobs` is found at run time, and one this list does not classify is treated as
 *   period-bound — a new table can never silently open the destructive path. A CI test forces each to be classified.
 * - **J2:** while a period can move, the emissions window moves with it; **automatic** dataset selections are deleted
 *   and re-derived for the new window (the audit records both sets); **manual** selections stay, their coverage
 *   warning recomputed.
 * - **J3:** a job with a v7 identity keeps its start date and period until cutover (`IMPORTED_FROM_V7`) — they are in
 *   the client loader's compare set, so one edit would make the next re-load refuse the whole client. Its template may
 *   change (not compared — C5).
 * - **J4:** a complete or cancelled job is refused (`JOB_CLOSED`). **J5:** a period change needs a reason.
 * - **J6:** the milestones re-anchor through PR 3's `applyReschedule` — only uncompleted template rows move (Q11) —
 *   under one job-version check and one bump; each milestone row versions on its own.
 * - `reporting_year` is re-derived from the new period end by `reportingYearForPeriod`, the helper job.create uses
 *   (NZC-092: the year the period ends in; never sent).
 *
 * `planJobUpdate` is the one computation: the command applies it, and the job page's preview shows it.
 */

// ── J1: which job-linked tables hold period-bound data ─────────────────────────────────────────────────────────

/**
 * Every table with a foreign key to `jobs`, classified. **Period-bound** data is measured against, reported for, or
 * derived from the job's reporting period — moving the period would silently change what it means. Tables this command
 * itself keeps in step (the window, its dataset selections, the milestones) are not, nor are tables of families with
 * no period, nor records of access or stage history.
 *
 * Tables linked to a job only through one of these are covered by it: a portal data-entry record hangs off a bucket
 * grant, which names a scope row — so a job with portal records has scope rows, which are period-bound.
 */
export const JOB_TABLE_CLASSIFICATION: Readonly<Record<string, { periodBound: boolean; why: string }>> = {
  job_scope_rows: { periodBound: true, why: "activity entered for the period, month by month" },
  job_emission_sources: { periodBound: true, why: "registered sources and their monthly activity" },
  job_emission_groups: { periodBound: true, why: "grouped sources for the period" },
  scope_row_review_history: { periodBound: true, why: "reviews of the period's rows" },
  gap_resolutions: { periodBound: true, why: "gaps resolved against the period's boundary (NZC-070)" },
  client_factors: { periodBound: true, why: "factors chosen for the period's activity" },
  job_intensity_values: { periodBound: true, why: "keyed by the reporting year" },
  job_intensity_targets: { periodBound: true, why: "set against the reporting year" },
  job_emissions_targets: { periodBound: true, why: "set against the period's baseline" },
  reviewed_crp_snapshots: { periodBound: true, why: "a reviewed snapshot records the period it was made for" },
  report_versions: { periodBound: true, why: "a report is issued for the period" },
  report_compositions: { periodBound: true, why: "a report's composition for the period" },
  report_sections: { periodBound: true, why: "a report's sections for the period" },
  report_section_versions: { periodBound: true, why: "a report's section history" },
  legacy_report_versions: { periodBound: true, why: "v7's reports for the period" },
  portal_report_approvals: { periodBound: true, why: "a client's approval of the period's report" },
  portal_report_comments: { periodBound: true, why: "a client's comments on the period's report" },
  portal_tracker_actions: { periodBound: true, why: "actions tracked against the period's report" },
  // Kept in step by this command, or not about the period.
  job_emissions_config: { periodBound: false, why: "the window itself — moved by this command (J2)" },
  job_dataset_selections: { periodBound: false, why: "re-derived by this command (J2)" },
  job_milestones: { periodBound: false, why: "re-anchored by this command (J6)" },
  job_stage_history: { periodBound: false, why: "a record of stage moves, not of the period" },
  portal_access_grants: { periodBound: false, why: "who may see the job, not what it measured" },
  lca_assessments: { periodBound: false, why: "LCA has no reporting period" },
  job_consultancy_details: { periodBound: false, why: "consultancy has no reporting period" },
  consultancy_deliverables: { periodBound: false, why: "consultancy has no reporting period" },
  training_course_runs: { periodBound: false, why: "training has no reporting period" },
  training_entitlements: { periodBound: false, why: "training has no reporting period" },
  training_run_snapshots: { periodBound: false, why: "training has no reporting period" },
  time_entries: { periodBound: false, why: "time worked on the job, dated by when it was done — not by the period it reports on" },
};

/** Every table with a foreign key to `jobs`, with the columns that hold the job's organisation and id. */
export async function jobLinkedTables(db: Queryable): Promise<Array<{ table: string; organisationColumn: string; jobColumn: string }>> {
  const { rows } = await db.query<{ table_name: string; cols: string[]; refcols: string[] }>(
    `SELECT cl.relname AS table_name,
            array(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols,
            array(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS refcols
       FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace n ON n.oid = cl.relnamespace
      WHERE con.contype = 'f' AND con.confrelid = 'nzi_console.jobs'::regclass AND n.nspname = 'nzi_console'
      ORDER BY 1`);
  return rows.map((row) => ({
    table: row.table_name,
    organisationColumn: row.cols[row.refcols.indexOf("organisation_id")] ?? "",
    jobColumn: row.cols[row.refcols.indexOf("job_id")] ?? "",
  }));
}

export type PeriodBoundFinding = { table: string; rows: number | null; why: string; classified: boolean };
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * The period-bound data a job holds — fail-closed (J1): a table the classification does not name is treated as
 * period-bound, and one that cannot be read or counted is reported as blocking rather than skipped.
 */
export async function periodBoundData(db: Queryable, organisationId: string, jobId: string): Promise<PeriodBoundFinding[]> {
  const findings: PeriodBoundFinding[] = [];
  for (const linked of await jobLinkedTables(db)) {
    const known = JOB_TABLE_CLASSIFICATION[linked.table];
    if (known && !known.periodBound) continue;
    const why = known?.why ?? "not yet classified — treated as period-bound until it is";
    if (![linked.table, linked.organisationColumn, linked.jobColumn].every((name) => IDENTIFIER.test(name))) {
      findings.push({ table: linked.table, rows: null, why: `${why}; its link to the job could not be read`, classified: !!known });
      continue;
    }
    const { rows: [access] } = await db.query<{ can: boolean }>(`SELECT has_table_privilege(current_user, $1, 'SELECT') AS can`, [`nzi_console.${linked.table}`]);
    if (!access?.can) { findings.push({ table: linked.table, rows: null, why: `${why}; it cannot be read here`, classified: !!known }); continue; }
    const { rows: [counted] } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nzi_console.${linked.table} WHERE ${linked.organisationColumn} = $1 AND ${linked.jobColumn} = $2`, [organisationId, jobId]);
    if ((counted?.n ?? 0) > 0) findings.push({ table: linked.table, rows: counted!.n, why, classified: !!known });
  }
  return findings;
}

// ── The plan (shared by the command and the preview) ───────────────────────────────────────────────────────────

type JobRow = {
  job_id: string; client_id: string; job_family: WorkflowJobFamily; status: string; source_system: string | null; version: number;
  start_date: string | null; due_date: string | null; period_start: string | null; period_end: string | null; reporting_year: number | null; milestone_template_id: string | null;
};
export type ScheduleFields = { startDate: string | null; reportingPeriodStart: string | null; reportingPeriodEnd: string | null; reportingYear: number | null; milestoneTemplateId: string | null };
export type DatasetChange = {
  window: { before: ReportingWindow | null; after: ReportingWindow } | null;
  /** J2: the automatic selections deleted, and those re-derived for the new window. */
  automaticRemoved: Array<{ datasetId: string; name: string }>;
  automaticAdded: Array<{ datasetId: string; name: string }>;
  /** Manual selections, kept, with their coverage warnings before and after. */
  manual: Array<{ datasetId: string; name: string; warningsBefore: string[]; warningsAfter: string[] }>;
};
export type JobUpdatePlan = {
  jobId: string; jobVersion: number; clientId: string; family: WorkflowJobFamily; imported: boolean; status: string;
  before: ScheduleFields; after: ScheduleFields;
  changed: { startDate: boolean; period: boolean; template: boolean };
  /** Refusals, as field issues. Empty ⇒ the command may apply the plan. */
  issues: Array<{ field: string; code: string; message: string }>;
  periodBound: PeriodBoundFinding[];
  datasets: DatasetChange | null;
  /** What happens to the milestones (the same planReschedule the panel previews), or null when nothing re-anchors. */
  reschedule: ReschedulePreview | null;
  reasonRequired: boolean;
};

const CLOSED = new Set(["complete", "cancelled"]);

export async function planJobUpdate(db: Queryable, organisationId: string, input: Omit<CommandInputMap["job.update"], "expectedVersion">, options: { lock: boolean }):
  Promise<{ plan: JobUpdatePlan; template: MilestoneTemplateWithItems | null } | null> {
  const { rows: [job] } = await db.query<JobRow>(
    `SELECT job_id, client_id, job_family, status, source_system, version, start_date::text AS start_date, due_date::text AS due_date,
            reporting_period_start::text AS period_start, reporting_period_end::text AS period_end, reporting_year, milestone_template_id
       FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 ${options.lock ? "FOR UPDATE" : ""}`, [organisationId, input.jobId]);
  if (!job) return null;
  const has = <K extends keyof typeof input>(key: K) => input[key] !== undefined;
  const before: ScheduleFields = { startDate: job.start_date, reportingPeriodStart: job.period_start, reportingPeriodEnd: job.period_end, reportingYear: job.reporting_year, milestoneTemplateId: job.milestone_template_id };
  const next = {
    startDate: has("startDate") ? input.startDate! : job.start_date,
    reportingPeriodStart: has("reportingPeriodStart") ? input.reportingPeriodStart ?? null : job.period_start,
    reportingPeriodEnd: has("reportingPeriodEnd") ? input.reportingPeriodEnd ?? null : job.period_end,
    milestoneTemplateId: has("milestoneTemplateId") ? input.milestoneTemplateId ?? null : job.milestone_template_id,
  };
  const changed = {
    startDate: next.startDate !== job.start_date,
    period: next.reportingPeriodStart !== job.period_start || next.reportingPeriodEnd !== job.period_end,
    template: next.milestoneTemplateId !== job.milestone_template_id,
  };
  const issues: JobUpdatePlan["issues"] = [];
  const imported = job.source_system !== null;
  const withPeriod = familyHasReportingPeriod(job.job_family);

  if (!changed.startDate && !changed.period && !changed.template) issues.push({ field: "jobId", code: "NO_CHANGE", message: "Nothing to change." });
  if (CLOSED.has(job.status)) issues.push({ field: "jobId", code: "JOB_CLOSED", message: `This job is ${job.status}; reopen it before changing its schedule.` });
  if (imported && changed.startDate) issues.push({ field: "startDate", code: "IMPORTED_FROM_V7", message: "Imported from v7: its start date stays as v7 holds it until cutover — a change here would stop the next v7 re-load." });
  if (imported && changed.period) issues.push({ field: "reportingPeriodStart", code: "IMPORTED_FROM_V7", message: "Imported from v7: its reporting period stays as v7 holds it until cutover — a change here would stop the next v7 re-load." });
  if (!withPeriod && changed.period) issues.push({ field: "reportingPeriodStart", code: "NO_PERIOD_FOR_FAMILY", message: "Only a carbon-reporting job has a reporting period." });
  if ((changed.startDate || changed.period) && !imported) {
    for (const issue of jobDateIssues({ startDate: next.startDate ?? "", dueDate: job.due_date ?? "", reportingPeriodStart: next.reportingPeriodStart, reportingPeriodEnd: next.reportingPeriodEnd }, { family: job.job_family })) {
      issues.push(issue);
    }
  }
  const periodBound = changed.period ? await periodBoundData(db, organisationId, input.jobId) : [];
  if (periodBound.length) {
    issues.push({ field: "reportingPeriodStart", code: "PERIOD_HAS_DATA",
      message: `The reporting period cannot move once data is recorded for it: ${periodBound.map((finding) => `${finding.table} (${finding.rows === null ? "unreadable" : `${finding.rows} row${finding.rows === 1 ? "" : "s"}`})`).join(", ")}.` });
  }
  let template: MilestoneTemplateWithItems | null = null;
  try { template = await templateForReschedule(db, organisationId, next.milestoneTemplateId); }
  catch (error) { if (error instanceof CommandValidationError) issues.push(...error.issues); else throw error; }

  const reportingYear = changed.period ? reportingYearForPeriod(next.reportingPeriodEnd) : job.reporting_year;
  const after: ScheduleFields = { ...next, reportingYear };

  // J2: the window and its datasets, when a CRP job's period moves.
  let datasets: DatasetChange | null = null;
  if (changed.period && withPeriod && next.reportingPeriodStart && next.reportingPeriodEnd) {
    const window = { from: next.reportingPeriodStart, to: next.reportingPeriodEnd };
    const { rows: [config] } = await db.query<{ reporting_from: string; reporting_to: string; country_code: string }>(
      `SELECT reporting_from::text AS reporting_from, reporting_to::text AS reporting_to, country_code FROM nzi_console.job_emissions_config WHERE organisation_id = $1 AND job_id = $2`,
      [organisationId, input.jobId]);
    const { rows: selected } = await db.query<{ dataset_id: string; name: string; selection_source: string; valid_from: string; valid_to: string; country_code: string; status: string }>(
      `SELECT s.dataset_id, d.name, s.selection_source, d.valid_from::text AS valid_from, d.valid_to::text AS valid_to, d.country_code, d.status
         FROM nzi_console.job_dataset_selections s JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (s.organisation_id, s.dataset_id)
        WHERE s.organisation_id = $1 AND s.job_id = $2 ORDER BY s.dataset_id`, [organisationId, input.jobId]);
    const manual = selected.filter((row) => row.selection_source === "manual");
    // The config's country; a job without one gets the country job.update writes when it creates the config.
    const jobCountry = config?.country_code ?? NEW_JOB_COUNTRY;
    const windowBefore = config ? { from: config.reporting_from, to: config.reporting_to } : null;
    datasets = {
      window: { before: windowBefore, after: window },
      automaticRemoved: selected.filter((row) => row.selection_source === "automatic").map((row) => ({ datasetId: row.dataset_id, name: row.name })),
      // A dataset already chosen by hand keeps its manual selection (job.create's ON CONFLICT DO NOTHING).
      automaticAdded: (await automaticDatasetsFor(db, organisationId, window, jobCountry)).filter((candidate) => !manual.some((row) => row.dataset_id === candidate.datasetId)),
      manual: manual.map((row) => {
        const dataset = { validFrom: row.valid_from, validTo: row.valid_to, country: row.country_code, status: row.status };
        return { datasetId: row.dataset_id, name: row.name, warningsBefore: windowBefore ? datasetCoverageWarnings(dataset, windowBefore, jobCountry) : [],
          warningsAfter: datasetCoverageWarnings(dataset, window, jobCountry) };
      }),
    };
  }

  // J6: the anchor or the template moved — the milestones re-anchor through PR 3's plan. A period end alone moves nothing.
  const anchorMoved = changed.startDate || next.reportingPeriodStart !== job.period_start;
  const reschedule = anchorMoved || changed.template
    ? planReschedule(await readScheduleRows(db, organisationId, input.jobId), template, anchorOf(next.startDate, next.reportingPeriodStart))
    : null;

  return {
    template,
    plan: {
      jobId: input.jobId, jobVersion: job.version, clientId: job.client_id, family: job.job_family, imported, status: job.status,
      before, after, changed, issues, periodBound, datasets, reschedule, reasonRequired: changed.period,
    },
  };
}

// ── The command ────────────────────────────────────────────────────────────────────────────────────────────────

export type JobUpdateResult = {
  jobId: string; clientId: string; version: number;
  schedule: ScheduleFields; datasets: DatasetChange | null; reschedule: ReschedulePreview | null; milestones: MilestoneState[];
};

export function updateJob(pool: PoolLike, input: CommandInputMap["job.update"], context: CommandContext): Promise<StoredOutcome<JobUpdateResult>> {
  return runPostgresCommand(pool, "job.update", input, context, async (db) => {
    const org = context.organisationId;
    const planned = await planJobUpdate(db, org, input, { lock: true });
    if (!planned) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "That job is not here." }]);
    const { plan, template } = planned;
    // The job's version, checked once — nothing below checks or bumps it again (J6).
    if (plan.jobVersion !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, plan.jobVersion);
    const issues = [...plan.issues];
    if (plan.reasonRequired && !context.reason?.trim()) issues.push({ field: "reason", code: "REQUIRED", message: "Say why the reporting period is changing — its label and window move with it." });
    if (issues.length) throw new CommandValidationError(issues);
    const milestonesBefore = await milestoneStatesOf(db, org, input.jobId);

    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.jobs SET start_date = $4::date, reporting_period_start = $5::date, reporting_period_end = $6::date, reporting_year = $7,
              milestone_template_id = $8, version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND job_id = $2 AND version = $3 RETURNING version`,
      [org, input.jobId, input.expectedVersion, plan.after.startDate, plan.after.reportingPeriodStart, plan.after.reportingPeriodEnd, plan.after.reportingYear, plan.after.milestoneTemplateId]);
    if (!saved) throw new VersionConflictError(input.expectedVersion, plan.jobVersion + 1);

    if (plan.datasets?.window) {
      const window = plan.datasets.window.after;
      if (plan.datasets.window.before) {
        await db.query(`UPDATE nzi_console.job_emissions_config SET reporting_from = $3, reporting_to = $4, version = version + 1 WHERE organisation_id = $1 AND job_id = $2`,
          [org, input.jobId, window.from, window.to]);
      } else {
        await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, $3, $4, $5)`,
          [org, input.jobId, window.from, window.to, NEW_JOB_COUNTRY]);
      }
      // J2: automatic selections are derived state — deleted and re-derived, for the country the config row holds; the
      // audit records both sets.
      await db.query(`DELETE FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2 AND selection_source = 'automatic'`, [org, input.jobId]);
      await selectAutomaticDatasets(db, org, input.jobId, window, (await jobCountryCode(db, org, input.jobId)) ?? NEW_JOB_COUNTRY, context.actorId);
      for (const manual of plan.datasets.manual) {
        await db.query(`UPDATE nzi_console.job_dataset_selections SET warnings_json = $4::jsonb WHERE organisation_id = $1 AND job_id = $2 AND dataset_id = $3`,
          [org, input.jobId, manual.datasetId, JSON.stringify(manual.warningsAfter)]);
      }
    }

    // J6: PR 3's reschedule, called directly — it touches milestone rows (each versions on its own), never the job row.
    const reschedule = plan.reschedule
      ? await applyReschedule(db, org, context.actorId, { jobId: input.jobId, startDate: plan.after.startDate, periodStart: plan.after.reportingPeriodStart }, template)
      : null;

    return {
      data: { jobId: input.jobId, clientId: plan.clientId, version: saved.version, schedule: plan.after, datasets: plan.datasets, reschedule,
        milestones: await milestoneStatesOf(db, org, input.jobId) },
      entityType: "job", entityId: input.jobId, topic: "job.updated",
      before: { schedule: plan.before, window: plan.datasets?.window?.before ?? null, automaticDatasets: plan.datasets?.automaticRemoved ?? null,
        manualWarnings: plan.datasets?.manual.map((m) => ({ datasetId: m.datasetId, warnings: m.warningsBefore })) ?? null, milestones: milestonesBefore },
    };
  });
}
