// Reporting F-1 (0164; RULING-reporting-F Q1–Q3, Q5, Q6; RULING-reporting-RF R-D1(ii)) — the client's report profile and a
// validated version's section plan.
//
// The profile is versioned and append-only, as 0159's template is: a change writes the next version; withdrawing writes a
// version with active = false, a reason and no plan. There is no row lock (no UPDATE privilege): two writers of the same next
// version meet at the primary key, and the loser is told the record moved. A version's plan seeds from the active profile at
// validate (`report.validate`) and may change while validated (`report.sectionPlan.update`), which bumps the version so
// publish's expectedVersion stays honest. Payloads carry section keys, an origin and a yes/no for the issuer line — never the
// line's words, money or a person (NZC-120).
import {
  defaultReportSectionPlan, reportSectionPlanIssues, reportSectionPlanOrigin,
  type CommandContext, type CommandInputMap, type ReportSectionPlan, type ReportSectionPlanOrigin,
} from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { CommandValidationError, requireReleasableSnapshot, runPostgresCommand, type StoredOutcome } from "./postgresCommands";
import { normaliseReportSectionPlan, readActiveReportProfile, readLatestReportProfile } from "./reportSectionPlanRecords";
export * from "./reportSectionPlanRecords";

/** A plan checked again on the server, against the rules as they stand — the contract's validator, enforced here too. */
function requireValidSectionPlan(plan: ReportSectionPlan): void {
  const issues = reportSectionPlanIssues(plan);
  if (issues.length) throw new CommandValidationError(issues);
}

/** The audit's view of a plan: its included keys in order, and whatever it leaves out — keys only. */
const planSummary = (plan: ReportSectionPlan, origin: ReportSectionPlanOrigin | string) => ({
  origin, order: plan.filter((entry) => entry.included).map((entry) => entry.key), excluded: plan.filter((entry) => !entry.included).map((entry) => entry.key),
});
const profileSummary = (version: number, active: boolean, plan: ReportSectionPlan | null, issuerLine: string | null) => ({
  version, active, order: plan ? plan.filter((entry) => entry.included).map((entry) => entry.key) : [], hasIssuerLine: issuerLine !== null,
});

async function requireClient(db: Queryable, organisationId: string, clientId: string): Promise<void> {
  const found = await db.query(`SELECT 1 FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [organisationId, clientId]);
  if (!found.rows[0]) throw new CommandValidationError([{ field: "clientId", code: "NOT_FOUND", message: "Client was not found." }]);
}

async function insertProfile(db: Queryable, values: unknown[], expected: number): Promise<void> {
  try {
    await db.query(`INSERT INTO nzi_console.client_report_profiles (organisation_id, client_id, version, active, section_plan, issuer_line, reason, set_by, correlation_id)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`, values);
  } catch (error) { if ((error as { code?: string }).code === "23505") throw new VersionConflictError(expected, expected + 1); throw error; }
}

export type ReportProfileResult = { clientId: string; version: number; active: boolean; order: string[]; hasIssuerLine: boolean };

/** Set the client's report profile, as the next version. */
export function setClientReportProfile(pool: PoolLike, input: CommandInputMap["client.reportProfile.set"], context: CommandContext): Promise<StoredOutcome<ReportProfileResult>> {
  return runPostgresCommand(pool, "client.reportProfile.set", input, context, async (db) => {
    await requireClient(db, context.organisationId, input.clientId);
    const latest = await readLatestReportProfile(db, context.organisationId, input.clientId);
    if ((latest?.version ?? 0) !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, latest?.version ?? 0);
    const plan = normaliseReportSectionPlan(input.sectionPlan);
    requireValidSectionPlan(plan);
    const version = input.expectedVersion + 1;
    const issuerLine = input.issuerLine ?? null;
    await insertProfile(db, [context.organisationId, input.clientId, version, true, JSON.stringify(plan), issuerLine, context.reason?.trim() || null, context.actorId, context.correlationId], input.expectedVersion);
    return {
      data: { clientId: input.clientId, ...profileSummary(version, true, plan, issuerLine) },
      ...(latest ? { before: profileSummary(latest.version, latest.active, latest.sectionPlan, latest.issuerLine) } : {}),
      entityType: "client_report_profile", entityId: input.clientId, topic: "client.report_profile.set",
    };
  });
}

/** Withdraw it — a version that says so, with a reason and no plan. Never a delete. */
export function deactivateClientReportProfile(pool: PoolLike, input: CommandInputMap["client.reportProfile.deactivate"], context: CommandContext): Promise<StoredOutcome<ReportProfileResult>> {
  return runPostgresCommand(pool, "client.reportProfile.deactivate", input, context, async (db) => {
    await requireClient(db, context.organisationId, input.clientId);
    const latest = await readLatestReportProfile(db, context.organisationId, input.clientId);
    if ((latest?.version ?? 0) !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, latest?.version ?? 0);
    if (!latest) throw new CommandValidationError([{ field: "clientId", code: "NOT_FOUND", message: "This client has no report profile to withdraw." }]);
    if (!latest.active) throw new CommandValidationError([{ field: "clientId", code: "ALREADY_INACTIVE", message: "The report profile is already withdrawn." }]);
    const version = latest.version + 1;
    await insertProfile(db, [context.organisationId, input.clientId, version, false, null, null, context.reason!.trim(), context.actorId, context.correlationId], input.expectedVersion);
    return {
      data: { clientId: input.clientId, ...profileSummary(version, false, null, null) },
      before: profileSummary(latest.version, true, latest.sectionPlan, latest.issuerLine),
      entityType: "client_report_profile", entityId: input.clientId, topic: "client.report_profile.deactivated",
    };
  });
}

/**
 * Change a validated version's section plan (Q2). Presentation, not evidence: the snapshot, manifest, scope and figures are
 * untouched, and the plan becomes immutable when publish freezes it into the composition. Version-checked and bumped, so
 * publish's expectedVersion (and F-3's preview hash) stay coherent; re-validated against the rules; refused once published
 * or superseded; held to the same separation of duties as validate and publish; audited before and after.
 */
export function updateReportSectionPlan(pool: PoolLike, input: CommandInputMap["report.sectionPlan.update"], context: CommandContext): Promise<StoredOutcome<{ reportVersionId: string; version: number } & ReturnType<typeof planSummary>>> {
  return runPostgresCommand(pool, "report.sectionPlan.update", input, context, async (db) => {
    const row = (await db.query<{ status: string; version: number; reviewed_snapshot_id: string; section_plan: ReportSectionPlan | null; section_plan_origin: string | null; client_id: string }>(
      `SELECT r.status, r.version, r.reviewed_snapshot_id, r.section_plan, r.section_plan_origin, j.client_id
         FROM nzi_console.report_versions r
         JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (r.organisation_id, r.job_id)
        WHERE r.organisation_id = $1 AND r.report_version_id = $2
        FOR UPDATE OF r`, [context.organisationId, input.reportVersionId])).rows[0];
    if (!row) throw new CommandValidationError([{ field: "reportVersionId", code: "NOT_FOUND", message: "Report version was not found." }]);
    if (row.version !== input.expectedVersion) throw new VersionConflictError(input.expectedVersion, row.version);
    if (row.status !== "validated") throw new CommandValidationError([{ field: "reportVersionId", code: "PRECONDITION", message: "Only a validated report's sections can be reordered — a published report is fixed as it was issued." }]);
    const source = (await db.query<{ created_by: string; approved_by: string | null }>(
      `SELECT created_by, approved_by FROM nzi_console.reviewed_crp_snapshots WHERE organisation_id = $1 AND snapshot_id = $2`,
      [context.organisationId, row.reviewed_snapshot_id])).rows[0];
    if (!source) throw new CommandValidationError([{ field: "reportVersionId", code: "NOT_FOUND", message: "Reviewed snapshot was not found." }]);
    requireReleasableSnapshot(context, source);
    const plan = normaliseReportSectionPlan(input.sectionPlan);
    requireValidSectionPlan(plan);
    const origin = reportSectionPlanOrigin(plan, await readActiveReportProfile(db, context.organisationId, row.client_id));
    const updated = await db.query<{ version: number }>(
      `UPDATE nzi_console.report_versions SET section_plan = $3::jsonb, section_plan_origin = $4, version = version + 1
        WHERE organisation_id = $1 AND report_version_id = $2 AND status = 'validated' AND version = $5 RETURNING version`,
      [context.organisationId, input.reportVersionId, JSON.stringify(plan), origin, input.expectedVersion]);
    if (!updated.rows[0]) throw new VersionConflictError(input.expectedVersion, row.version);
    return {
      data: { reportVersionId: input.reportVersionId, version: updated.rows[0].version, ...planSummary(plan, origin) },
      before: planSummary(row.section_plan ?? defaultReportSectionPlan, row.section_plan_origin ?? "default"),
      entityType: "report_version", entityId: input.reportVersionId, topic: "report.section_plan.updated",
    };
  });
}
