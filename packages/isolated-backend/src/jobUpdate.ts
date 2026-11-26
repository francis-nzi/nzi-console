import { randomUUID } from "node:crypto";
import {
  anchorOf, datasetSeriesKey, familyHasReportingPeriod, isSamePeriod, jobDateIssues, planReschedule, reportingYearForPeriod, type CommandContext, type CommandInputMap, type ReschedulePreview,
  type WorkflowJobFamily,
} from "@nzi/contracts";
import { automaticDatasetsFor, datasetCoverageWarnings, selectAutomaticDatasets, type ReportingWindow } from "./datasetSelection";
import { clientCountryOf, jobCountryScope } from "./datasetScope";
import { VersionConflictError } from "./errors";
import { moveSeriesRows, planSeries, type SeriesMovePlan } from "./jobDatasetUpdate";
import { applyReschedule, milestoneStatesOf, readScheduleRows, templateForReschedule, type MilestoneState, type MilestoneTemplateWithItems } from "./milestoneCommands";
import { CommandValidationError, recalculateScopeRowInTransaction, runPostgresCommand, runPostgresCommandInTransaction, type StoredOutcome } from "./postgresCommands";
import { withTenantWrite, type PoolLike, type Queryable } from "./postgres";

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
  reviewed_crp_snapshot_supersessions: { periodBound: true, why: "a reviewed snapshot superseded by a newer import of the period's rows (0234)" },
  report_versions: { periodBound: true, why: "a report is issued for the period" },
  report_compositions: { periodBound: true, why: "a report's composition for the period" },
  report_sections: { periodBound: true, why: "a report's sections for the period" },
  report_section_versions: { periodBound: true, why: "a report's section history" },
  legacy_report_versions: { periodBound: true, why: "the previous system's reports for the period" },
  v7_reingest_runs: { periodBound: true, why: "a re-ingest reconciled to the previous system's figures for the period (0166)" },
  v7_resync_runs: { periodBound: true, why: "a re-sync brought the job's rows level with the previous system's records for the period (0225)" },
  v7_import_sessions: { periodBound: true, why: "an import summary compares the job's rows with the previous system's records for the period (0226)" },
  v7_import_ingests: { periodBound: true, why: "a rehearsal or ingest of the period's imported rows, reconciled per scope (0229)" },
  v7_drift_checks: { periodBound: true, why: "the period's scope totals checked against the previous system's own (0236)" },
  v7_import_decisions: { periodBound: true, why: "a person's resolution of the period's imported rows — the crosswalk Phase 3 ingests (0228)" },
  // Not period-bound: a batch's per-job outcome (refreshed, queued, failed — ids, codes, counts) is the run's record, not data of the
  // period. A refresh it caused is period-bound already, through its 0229 ingest.
  v7_import_batch_results: { periodBound: false, why: "a batch run's outcome for the job — ids, codes and counts, no figures (0232)" },
  portal_report_approvals: { periodBound: true, why: "a client's approval of the period's report" },
  portal_report_comments: { periodBound: true, why: "a client's comments on the period's report" },
  portal_tracker_actions: { periodBound: true, why: "actions tracked against the period's report" },
  // Data entry D3 (0194): the CRM's average FX rate over the reporting period — a different period is a different average.
  job_site_fx_rates: { periodBound: true, why: "the average FX rate over the reporting period" },
  // Commuting uplift (0219): the headcount at each site in the period - a different period is a different workforce.
  job_site_headcount: { periodBound: true, why: "the headcount at each site over the reporting period" },
  // Data entry D3 (0195): the prior job this job's carried lines came from — chosen as the year before this period.
  job_carry_forward_basis: { periodBound: true, why: "the prior period this job's carried-forward lines came from" },
  // Kept in step by this command, or not about the period.
  job_emissions_config: { periodBound: false, why: "the window itself — moved by this command (J2)" },
  job_dataset_selections: { periodBound: false, why: "re-derived by this command (J2)" },
  job_milestones: { periodBound: false, why: "re-anchored by this command (J6)" },
  // Addendum B (0238): who owns each of the job's dates, and what V7 last said they were — about the dates, not the period's data.
  job_date_owners: { periodBound: false, why: "who owns each of the job's dates (the console or the previous system) — written by this command" },
  job_v7_date_observations: { periodBound: false, why: "what the previous system last said the job's dates were — dates only" },
  job_stage_history: { periodBound: false, why: "a record of stage moves, not of the period" },
  portal_access_grants: { periodBound: false, why: "who may see the job, not what it measured" },
  portal_files: { periodBound: false, why: "a document shared for the job, not data measured for the period" },
  portal_threads: { periodBound: false, why: "a conversation about the job, not data measured for the period (a report's comments are classified on their own table, and its thread only exists with them)" },
  lca_assessments: { periodBound: false, why: "LCA has no reporting period" },
  job_consultancy_details: { periodBound: false, why: "consultancy has no reporting period" },
  consultancy_deliverables: { periodBound: false, why: "consultancy has no reporting period" },
  training_course_runs: { periodBound: false, why: "training has no reporting period" },
  training_entitlements: { periodBound: false, why: "training has no reporting period" },
  training_run_snapshots: { periodBound: false, why: "training has no reporting period" },
  time_entries: { periodBound: false, why: "time worked on the job, dated by when it was done — not by the period it reports on" },
  // CRM tasks (0223): an internal to-do about the job, dated by when it is due — not data measured for the period.
  crm_tasks: { periodBound: false, why: "an internal staff to-do about the job — workflow, not data for the period" },
  // Phase 3a (0161): which client sites the job reports on — a decision about the report's scope, not a measurement of the
  // period; moving the period does not change what it says (the site's own in-service dates still decide the boundary).
  job_site_inclusions: { periodBound: false, why: "which of the client's sites the job reports on — a scope decision, not data for the period" },
  // Data entry D2 (0193): an AI suggestion of where a GL code or description belongs — about the client's chart of accounts, not
  // a measurement of the period; the job only records where it was asked.
  spend_allocation_suggestions: { periodBound: false, why: "a suggested category for a ledger line — about the client's chart of accounts, not the period" },
  // Data entry D3 (0195): a client's request to reopen a reviewed entry — a message in the job's workflow, not data for the period.
  scope_row_reopen_requests: { periodBound: false, why: "a client's request to reopen an entry — workflow, not data for the period" },
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
 * Rows a period-bound table holds that are not data for the period, and so do not lock it (Phase 3b, ruled #10).
 *
 * A scope row that is still a **discardable draft** — live, no quantity and no monthly figure, never calculated or
 * overridden, pending and never reviewed (`scopeRowIsDiscardable`, the same test `scope.row.discard` applies) — is a
 * shape awaiting entry, as template seeding creates them. It measures nothing in the period, so moving the period
 * changes nothing it says. The moment anyone enters a figure, calculates, overrides or reviews it, it counts again.
 */
export const NOT_PERIOD_DATA: Readonly<Record<string, string>> = {
  job_scope_rows: `origin <> 'migrated' AND quantity IS NULL
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(monthly_activity_json) = 'array' THEN monthly_activity_json ELSE '[]'::jsonb END) slot
                     WHERE slot->>'quantity' IS NOT NULL)
    AND calculated_tco2e IS NULL AND override_tco2e IS NULL AND review_status = 'pending' AND reviewed_by IS NULL`,
};

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
    const draft = NOT_PERIOD_DATA[linked.table];
    const { rows: [counted] } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM nzi_console.${linked.table} WHERE ${linked.organisationColumn} = $1 AND ${linked.jobColumn} = $2${draft ? ` AND NOT (${draft})` : ""}`, [organisationId, jobId]);
    if ((counted?.n ?? 0) > 0) findings.push({ table: linked.table, rows: counted!.n, why, classified: !!known });
  }
  return findings;
}

// ── The plan (shared by the command and the preview) ───────────────────────────────────────────────────────────

type JobRow = {
  job_id: string; client_id: string; job_family: WorkflowJobFamily; status: string; source_system: string | null; version: number;
  start_date: string | null; due_date: string | null; period_start: string | null; period_end: string | null; reporting_year: number | null; milestone_template_id: string | null;
};
export type ScheduleFields = { startDate: string | null; dueDate: string | null; reportingPeriodStart: string | null; reportingPeriodEnd: string | null; reportingYear: number | null; milestoneTemplateId: string | null };
export type DatasetChange = {
  window: { before: ReportingWindow | null; after: ReportingWindow } | null;
  /** J2: the automatic selections deleted, and those re-derived for the new window. */
  automaticRemoved: Array<{ datasetId: string; name: string }>;
  automaticAdded: Array<{ datasetId: string; name: string }>;
  /** Manual selections, kept, with their coverage warnings before and after. */
  manual: Array<{ datasetId: string; name: string; warningsBefore: string[]; warningsAfter: string[] }>;
  /** R4: the job's country after the move — its client's, GB assumed where that is not known (D-D). */
  country: string;
};
export type JobUpdatePlan = {
  jobId: string; jobVersion: number; clientId: string; family: WorkflowJobFamily; imported: boolean; status: string;
  before: ScheduleFields; after: ScheduleFields;
  changed: { startDate: boolean; dueDate: boolean; period: boolean; template: boolean };
  /** Refusals, as field issues. Empty ⇒ the command may apply the plan. */
  issues: Array<{ field: string; code: string; message: string }>;
  periodBound: PeriodBoundFinding[];
  /** Addendum B.3: the period moves over recorded data — the rows on a re-chosen dataset are re-priced, and the reason is required. */
  periodHasData: boolean;
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
  const before: ScheduleFields = { startDate: job.start_date, dueDate: job.due_date, reportingPeriodStart: job.period_start, reportingPeriodEnd: job.period_end, reportingYear: job.reporting_year, milestoneTemplateId: job.milestone_template_id };
  const next = {
    startDate: has("startDate") ? input.startDate! : job.start_date,
    // Addendum B, extended 26 Nov (ruled): the job's own due date is edited here too, under the same owner rule.
    dueDate: has("dueDate") ? input.dueDate! : job.due_date,
    reportingPeriodStart: has("reportingPeriodStart") ? input.reportingPeriodStart ?? null : job.period_start,
    reportingPeriodEnd: has("reportingPeriodEnd") ? input.reportingPeriodEnd ?? null : job.period_end,
    milestoneTemplateId: has("milestoneTemplateId") ? input.milestoneTemplateId ?? null : job.milestone_template_id,
  };
  const changed = {
    startDate: next.startDate !== job.start_date,
    dueDate: next.dueDate !== job.due_date,
    period: next.reportingPeriodStart !== job.period_start || next.reportingPeriodEnd !== job.period_end,
    template: next.milestoneTemplateId !== job.milestone_template_id,
  };
  const issues: JobUpdatePlan["issues"] = [];
  const imported = job.source_system !== null;
  const withPeriod = familyHasReportingPeriod(job.job_family);

  if (!changed.startDate && !changed.dueDate && !changed.period && !changed.template) issues.push({ field: "jobId", code: "NO_CHANGE", message: "Nothing to change." });
  if (CLOSED.has(job.status)) issues.push({ field: "jobId", code: "JOB_CLOSED", message: `This job is ${job.status}; reopen it before changing its schedule.` });
  // Addendum B (ruled 25 Nov 2026): an imported job's dates are editable here too — the console then owns the date it edits
  // (job_date_owners, 0238) and a later sync flags V7's difference instead of overwriting it. J3's IMPORTED_FROM_V7 is retired.
  if (!withPeriod && changed.period) issues.push({ field: "reportingPeriodStart", code: "NO_PERIOD_FOR_FAMILY", message: "Only a carbon-reporting job has a reporting period." });
  if (changed.startDate || changed.dueDate || changed.period) {
    for (const issue of jobDateIssues({ startDate: next.startDate ?? "", dueDate: next.dueDate ?? "", reportingPeriodStart: next.reportingPeriodStart, reportingPeriodEnd: next.reportingPeriodEnd }, { family: job.job_family })) {
      // An imported job's due date is V7's and may predate a date it never checked; it is judged only when this save moves it.
      if (imported && issue.field === "dueDate" && !changed.dueDate) continue;
      issues.push(issue);
    }
  }
  const periodBound = changed.period ? await periodBoundData(db, organisationId, input.jobId) : [];
  // Addendum B.3: a period with data may move, with a reason — the datasets are re-chosen and the rows re-priced (below, in
  // the command). Still refused, fail-closed (J1): a table nobody has classified, or one that cannot be read.
  const unclassified = periodBound.filter((finding) => !finding.classified || finding.rows === null);
  if (unclassified.length) {
    issues.push({ field: "reportingPeriodStart", code: "PERIOD_HAS_DATA",
      message: `The reporting period cannot move while data it cannot classify is recorded for it: ${unclassified.map((finding) => `${finding.table} (${finding.rows === null ? "unreadable" : `${finding.rows} row${finding.rows === 1 ? "" : "s"}`})`).join(", ")}.` });
  }
  // …and a job whose figures are issued (a reviewed snapshot or a published report): the issued figures are for the period they
  // name. Moving it goes through the supersession route (#655, a newer import superseding the snapshot), not here.
  const issued = changed.period ? await jobHasIssuedFigures(db, organisationId, input.jobId) : false;
  if (issued) {
    issues.push({ field: "reportingPeriodStart", code: "PERIOD_ISSUED",
      message: "This job has a reviewed snapshot or a published report for its period, so the period can’t move here. Supersede the snapshot first (the bring-in route), then move the period." });
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
    // R4: a moved window re-reads the client's country — the country written to the config below and chosen for, with each
    // included site's. Where the client's is not known, the config keeps the country it holds (GB for a job without one, D-D).
    const client = await clientCountryOf(db, organisationId, job.client_id);
    const jobCountry = client.assumed ? config?.country_code ?? client.code : client.code;
    const scope = await jobCountryScope(db, organisationId, input.jobId, jobCountry);
    const windowBefore = config ? { from: config.reporting_from, to: config.reporting_to } : null;
    datasets = {
      window: { before: windowBefore, after: window }, country: jobCountry,
      automaticRemoved: selected.filter((row) => row.selection_source === "automatic").map((row) => ({ datasetId: row.dataset_id, name: row.name })),
      // A dataset already chosen by hand keeps its manual selection (job.create's ON CONFLICT DO NOTHING).
      automaticAdded: (await automaticDatasetsFor(db, organisationId, window, jobCountry, scope)).filter((candidate) => !manual.some((row) => row.dataset_id === candidate.datasetId)),
      manual: manual.map((row) => {
        const dataset = { validFrom: row.valid_from, validTo: row.valid_to, country: row.country_code, status: row.status };
        return { datasetId: row.dataset_id, name: row.name, warningsBefore: windowBefore ? datasetCoverageWarnings(dataset, windowBefore, config?.country_code ?? jobCountry) : [],
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
      before, after, changed, issues, periodBound, periodHasData: periodBound.length > 0, datasets, reschedule, reasonRequired: changed.period,
    },
  };
}

// ── The command ────────────────────────────────────────────────────────────────────────────────────────────────

/** The job has issued figures: a reviewed snapshot, or a published report (as job.datasets.update asks it). */
export async function jobHasIssuedFigures(db: Queryable, organisationId: string, jobId: string): Promise<boolean> {
  return (await db.query(
    `SELECT 1 FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND job_id = $2
     UNION ALL SELECT 1 FROM nzi_console.report_versions WHERE organisation_id = $1 AND job_id = $2 AND status = 'published' LIMIT 1`, [organisationId, jobId])).rows.length > 0;
}

/** The job's enabled totals per scope, as the preview and the audit show them before and after a period move. */
export type ScopeTotals = { scope1: number; scope2: number; scope3: number; total: number };
async function scopeTotals(db: Queryable, organisationId: string, jobId: string): Promise<ScopeTotals> {
  const { rows } = await db.query<{ scope: string; tco2e: string }>(
    `SELECT split_part(scope, '.', 1) AS scope, coalesce(sum(coalesce(override_tco2e, calculated_tco2e, 0)), 0)::text AS tco2e
       FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND enabled GROUP BY 1`, [organisationId, jobId]);
  const of = (scope: string) => Number(rows.find((row) => row.scope === scope)?.tco2e ?? 0);
  const totals = { scope1: of("1"), scope2: of("2"), scope3: of("3") };
  return { ...totals, total: totals.scope1 + totals.scope2 + totals.scope3 };
}

/** Where the change came from: a person in the console (who then owns the dates they edit), or the V7 sync following V7. */
export type JobUpdateOrigin = "console" | "v7-sync";

export type JobUpdateResult = {
  jobId: string; clientId: string; version: number;
  schedule: ScheduleFields; datasets: DatasetChange | null; reschedule: ReschedulePreview | null; milestones: MilestoneState[];
  /** Addendum B.3: rows re-priced onto a re-chosen dataset, and the totals per scope before and after. */
  repriced: { rows: number; series: Array<{ from: string; to: string }> };
  totals: { before: ScopeTotals; after: ScopeTotals };
  /** Addendum B.4: the job is its client's baseline year — the client's baseline period can move with it (a re-baseline). */
  baselineYearJob: boolean;
  /** Addendum B.2: the dates this save made the console's. */
  ownedDates: string[];
};

function jobUpdateHandler(input: CommandInputMap["job.update"], context: CommandContext, origin: JobUpdateOrigin) {
  return async (db: Queryable) => {
    const org = context.organisationId;
    const planned = await planJobUpdate(db, org, input, { lock: true });
    if (!planned) throw new CommandValidationError([{ field: "jobId", code: "NOT_FOUND", message: "That job is not here." }]);
    const { plan, template } = planned;
    // The job's version, checked once — nothing below checks or bumps it again (J6).
    if (plan.jobVersion !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, plan.jobVersion);
    const issues = [...plan.issues];
    if (plan.reasonRequired && !context.reason?.trim()) {
      issues.push({ field: "reason", code: "REQUIRED", message: plan.periodHasData
        ? "Say why the reporting period is changing — data is recorded for it, so its datasets are re-chosen and its rows re-priced."
        : "Say why the reporting period is changing — its label and window move with it." });
    }
    if (issues.length) throw new CommandValidationError(issues);
    const milestonesBefore = await milestoneStatesOf(db, org, input.jobId);
    const totalsBefore = await scopeTotals(db, org, input.jobId);
    const baselineYearJob = plan.changed.period ? await wasBaselineYearJob(db, org, input.jobId) : false;

    const { rows: [saved] } = await db.query<{ version: number }>(
      `UPDATE nzi_console.jobs SET start_date = $4::date, reporting_period_start = $5::date, reporting_period_end = $6::date, reporting_year = $7,
              milestone_template_id = $8, due_date = $9::date, version = version + 1, updated_at = now()
        WHERE organisation_id = $1 AND job_id = $2 AND version = $3 RETURNING version`,
      [org, input.jobId, input.expectedVersion, plan.after.startDate, plan.after.reportingPeriodStart, plan.after.reportingPeriodEnd, plan.after.reportingYear, plan.after.milestoneTemplateId, plan.after.dueDate]);
    if (!saved) throw new VersionConflictError(input.expectedVersion, plan.jobVersion + 1);

    const repriced: JobUpdateResult["repriced"] = { rows: 0, series: [] };
    if (plan.datasets?.window) {
      const window = plan.datasets.window.after;
      if (plan.datasets.window.before) {
        await db.query(`UPDATE nzi_console.job_emissions_config SET reporting_from = $3, reporting_to = $4, country_code = $5, version = version + 1 WHERE organisation_id = $1 AND job_id = $2`,
          [org, input.jobId, window.from, window.to, plan.datasets.country]);
      } else {
        await db.query(`INSERT INTO nzi_console.job_emissions_config (organisation_id, job_id, reporting_from, reporting_to, country_code) VALUES ($1, $2, $3, $4, $5)`,
          [org, input.jobId, window.from, window.to, plan.datasets.country]);
      }
      // Addendum B.3: the rows priced on an automatic edition that the new period does not choose, planned against the
      // edition of the same series it does choose — before the selections change, so the plan reads the rows as they stand.
      const removed = plan.datasets.automaticRemoved.filter((old) => !plan.datasets!.automaticAdded.some((added) => added.datasetId === old.datasetId));
      const moves: SeriesMovePlan[] = [];
      const stranded: string[] = [];
      for (const old of removed) {
        // Per calendar year (#662) the new period may choose two editions of the series; a row moves to the latest (the end
        // year's), and monthly pricing then prices each month at its own year's edition.
        const successor = plan.datasets.automaticAdded.filter((added) => datasetSeriesKey(added.datasetId) === datasetSeriesKey(old.datasetId))
          .sort((a, b) => b.datasetId.localeCompare(a.datasetId))[0];
        const onIt = Number((await db.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2 AND origin = 'live' AND factor_source = 'dataset' AND dataset_id = $3`,
          [org, input.jobId, old.datasetId])).rows[0]!.n);
        if (onIt === 0) continue;
        if (!successor) { stranded.push(`${old.name} (${onIt} row${onIt === 1 ? "" : "s"})`); continue; }
        moves.push(await planSeries(db, org, input.jobId, { seriesKey: datasetSeriesKey(old.datasetId), countryCode: plan.datasets.country, fromDatasetId: old.datasetId, toDatasetId: successor.datasetId,
          fromLabel: old.name, toLabel: successor.name, years: null, keepFrom: false }, []));
      }
      if (stranded.length) {
        throw new CommandValidationError([{ field: "reportingPeriodStart", code: "ROWS_ON_UNCHOSEN_DATASET",
          message: `The new period chooses no edition of ${stranded.join(", ")} — those rows have nothing to be re-priced on. Choose that dataset by hand first, then move the period.` }]);
      }
      const blocked = moves.flatMap((move) => move.blocked.map((row) => ({ field: "reportingPeriodStart", code: "SERIES_BLOCKED",
        message: `${row.label} (${row.reason}) can’t be re-priced on ${move.toLabel}. Resolve it on the job, then move the period.` })));
      if (blocked.length) throw new CommandValidationError(blocked);

      // J2: automatic selections are derived state — deleted and re-derived, for the country the config row holds; the
      // audit records both sets.
      await db.query(`DELETE FROM nzi_console.job_dataset_selections WHERE organisation_id = $1 AND job_id = $2 AND selection_source = 'automatic'`, [org, input.jobId]);
      await selectAutomaticDatasets(db, org, input.jobId, window, plan.datasets.country, context.actorId);
      for (const manual of plan.datasets.manual) {
        await db.query(`UPDATE nzi_console.job_dataset_selections SET warnings_json = $4::jsonb WHERE organisation_id = $1 AND job_id = $2 AND dataset_id = $3`,
          [org, input.jobId, manual.datasetId, JSON.stringify(manual.warningsAfter)]);
      }
      // Re-priced by the one row calculation, which since #662 prices a window by month, each month at its year's selected
      // edition (DESIGN-datasets-by-period-and-site). First the rows on an edition the new period does not choose move to the
      // series' edition it does; then every other live, dataset-priced row is recalculated — its months are the new window's.
      const note = (detail: string) => ({ title: "Re-priced for a new reporting period", detail: `${detail}${detail ? " · " : ""}${plan.before.reportingPeriodStart ?? "—"}–${plan.before.reportingPeriodEnd ?? "—"} → ${plan.after.reportingPeriodStart}–${plan.after.reportingPeriodEnd} · run ${context.correlationId}` });
      const moved = new Set<string>();
      for (const move of moves) {
        await moveSeriesRows(db, context, input.jobId, move, context.reason?.trim() || null, note(`${move.fromLabel} → ${move.toLabel}`));
        for (const row of move.moved) moved.add(row.rowId);
        repriced.rows += move.moved.filter((row) => row.recalculated).length;
        repriced.series.push({ from: move.fromDatasetId, to: move.toDatasetId });
      }
      if (plan.periodHasData) {
        // Not a register-managed row (it follows its source) nor a re-ingested one (V7's own vintage, attest-only), as planSeries holds.
        const { rows: live } = await db.query<{ scope_row_id: string; version: number }>(
          `SELECT scope_row_id, version FROM nzi_console.job_scope_rows
            WHERE organisation_id = $1 AND job_id = $2 AND origin = 'live' AND enabled AND factor_source = 'dataset'
              AND quantity IS NOT NULL AND unit IS NOT NULL AND source_id IS NULL AND reingested_from_row_id IS NULL
            ORDER BY scope_row_id`, [org, input.jobId]);
        for (const row of live) {
          if (moved.has(row.scope_row_id)) continue;
          await recalculateScopeRowInTransaction(db, { jobId: input.jobId, rowId: row.scope_row_id, expectedVersion: row.version }, context, [note("")]);
          repriced.rows += 1;
        }
      }
    }

    // J6: PR 3's reschedule, called directly — it touches milestone rows (each versions on its own), never the job row.
    const reschedule = plan.reschedule
      ? await applyReschedule(db, org, context.actorId, { jobId: input.jobId, startDate: plan.after.startDate, periodStart: plan.after.reportingPeriodStart }, template)
      : null;

    // Addendum B.2: an imported job's date edited here is the console's from now on; a later sync flags V7's instead.
    const ownedDates = origin === "console" && plan.imported
      ? [...(plan.changed.startDate ? ["start_date"] : []), ...(plan.changed.dueDate ? ["due_date"] : []), ...(plan.changed.period ? ["reporting_period"] : [])]
      : [];
    for (const dateKey of ownedDates) await recordDateOwner(db, context, input.jobId, dateKey, "console", "edited", null);

    const totalsAfter = await scopeTotals(db, org, input.jobId);
    return {
      data: { jobId: input.jobId, clientId: plan.clientId, version: saved.version, schedule: plan.after, datasets: plan.datasets, reschedule,
        milestones: await milestoneStatesOf(db, org, input.jobId), repriced, totals: { before: totalsBefore, after: totalsAfter }, baselineYearJob, ownedDates },
      entityType: "job", entityId: input.jobId, topic: "job.updated",
      before: { schedule: plan.before, window: plan.datasets?.window?.before ?? null, automaticDatasets: plan.datasets?.automaticRemoved ?? null,
        manualWarnings: plan.datasets?.manual.map((m) => ({ datasetId: m.datasetId, warnings: m.warningsBefore })) ?? null, milestones: milestonesBefore },
    };
  };
}

/** Whether the job's period, before this change, was its client's baseline period (Addendum B.4). */
async function wasBaselineYearJob(db: Queryable, organisationId: string, jobId: string): Promise<boolean> {
  const row = (await db.query<{ from: string | null; to: string | null; start: string | null; end: string | null }>(
    `SELECT coalesce(j.reporting_period_start, c.reporting_from)::text AS "from", coalesce(j.reporting_period_end, c.reporting_to)::text AS "to",
            cl.baseline_period_start::text AS start, cl.baseline_period_end::text AS "end"
       FROM nzi_console.jobs j JOIN nzi_console.clients cl ON (cl.organisation_id, cl.client_id) = (j.organisation_id, j.client_id)
       LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (j.organisation_id, j.job_id)
      WHERE j.organisation_id = $1 AND j.job_id = $2`, [organisationId, jobId])).rows[0];
  return Boolean(row?.from && row.to && row.start && row.end && isSamePeriod(row.from, row.to, row.start, row.end));
}

/** One owner row (append-only, 0238). The command's own audit event carries the change; this records whose the date is now. */
export async function recordDateOwner(db: Queryable, context: CommandContext, jobId: string, dateKey: string, owner: "console" | "v7", cause: "edited" | "kept" | "use-v7", acknowledged: number | null): Promise<void> {
  await db.query(
    `INSERT INTO nzi_console.job_date_owners (organisation_id, job_id, date_key, owner, cause, acknowledged_observation_no, set_by, correlation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [context.organisationId, jobId, dateKey, owner, cause, acknowledged, context.actorId, context.correlationId]);
}

export function updateJob(pool: PoolLike, input: CommandInputMap["job.update"], context: CommandContext): Promise<StoredOutcome<JobUpdateResult>> {
  return runPostgresCommand(pool, "job.update", input, context, jobUpdateHandler(input, context, "console"));
}

/** The same command inside a caller's transaction — the V7 date sync and "Use V7's dates" apply V7's dates through it. */
export function updateJobInTransaction(db: Queryable, input: CommandInputMap["job.update"], context: CommandContext, origin: JobUpdateOrigin): Promise<StoredOutcome<JobUpdateResult>> {
  return runPostgresCommandInTransaction(db, "job.update", input, context, jobUpdateHandler(input, context, origin));
}

class PreviewRollback extends Error {}

/** What a period move would do to the figures: the command itself, run and rolled back (Addendum B.3's preview). */
export type JobUpdatePreview = { plan: JobUpdatePlan; outcome: { totals: JobUpdateResult["totals"]; repriced: JobUpdateResult["repriced"] } | null; refusal: Array<{ field: string; code: string; message: string }> };

export async function previewJobUpdate(pool: PoolLike, input: Omit<CommandInputMap["job.update"], "expectedVersion">, context: CommandContext): Promise<JobUpdatePreview | null> {
  let preview: JobUpdatePreview | null = null;
  try {
    await withTenantWrite(pool, context.organisationId, async (db) => {
      const planned = await planJobUpdate(db, context.organisationId, input, { lock: false });
      if (!planned) return;
      preview = { plan: planned.plan, outcome: null, refusal: planned.plan.issues };
      if (planned.plan.issues.length === 0) {
        try {
          const outcome = await updateJobInTransaction(db, { ...input, expectedVersion: planned.plan.jobVersion },
            { ...context, idempotencyKey: `preview-${randomUUID()}`, reason: context.reason?.trim() || "preview" }, "console");
          preview = { ...preview, outcome: { totals: outcome.data.totals, repriced: outcome.data.repriced } };
        } catch (error) {
          if (!(error instanceof CommandValidationError)) throw error;
          preview = { ...preview, refusal: error.issues };
        }
      }
      throw new PreviewRollback();
    });
  } catch (error) {
    if (!(error instanceof PreviewRollback)) throw error;
  }
  return preview;
}
