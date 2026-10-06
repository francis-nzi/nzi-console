// Redesign Phase 1c (0159) — the client's reporting template: what the client reports, year to year, on the Client.
//
// A version is the whole template, header and lines written together (the shape of `client_targets`): a change writes
// the next version; withdrawing writes a version with active = false, a reason and no lines. Append-only, so there is no
// row lock (no UPDATE privilege, so no FOR UPDATE): two writers of the same next version meet at the primary key, and the
// loser is told the record moved.
//
// Three ways in: `set` (the whole template, from the card's editor), `initialiseFromJob` (the job's enabled rows, as
// `scope.row.rollforward` copies them — its v7 history comes in "to file"), and `deactivate`. Payloads carry counts, never
// labels, quantities, money or a person (NZC-120).
import { randomUUID } from "node:crypto";
import { REPORTING_TEMPLATE_MAX_LINES, type CommandContext, type CommandInputMap, type ReportingTemplateLineInput, type ReportingTemplateOrigin } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { SELECT_LATEST_TEMPLATE, readTemplateLines, type ReportingTemplateHeaderRow } from "./clientReportingTemplateRecords";
export * from "./clientReportingTemplateRecords";
import { CommandValidationError, runPostgresCommand, type StoredOutcome } from "./postgresCommands";

/** The command's data — also the audit event's after_json, so it carries the template's shape in counts, never a label. */
export type ReportingTemplateResult = { clientId: string; version: number; active: boolean; origin: ReportingTemplateOrigin; lineCount: number; byScope: Record<"1" | "2" | "3", number>; toFile: number };

async function insertHeader(db: Queryable, values: unknown[], expected: number): Promise<void> {
  try {
    await db.query(`INSERT INTO nzi_console.client_reporting_templates (organisation_id, client_id, version, active, origin, origin_ref, reason, set_by, correlation_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, values);
  } catch (error) { if ((error as { code?: string }).code === "23505") throw new VersionConflictError(expected, expected + 1); throw error; }
}

async function insertLines(db: Queryable, organisationId: string, clientId: string, version: number, lines: ReportingTemplateLineInput[]): Promise<void> {
  for (const [ordering, line] of lines.entries()) {
    await db.query(`INSERT INTO nzi_console.client_reporting_template_lines (organisation_id, client_id, version, line_id, scope, category_code, source_label, report_label, site_id, dataset_id, factor_id, unit, ordering)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [organisationId, clientId, version, randomUUID(), line.scope, line.categoryCode, line.sourceLabel.trim(), line.reportLabel?.trim() || null,
        line.siteId, line.datasetId, line.factorId, line.unit?.trim() || null, ordering]);
  }
}

/** The template as the audit reads it: its shape in counts — never a label, a quantity or a person. */
const summary = (version: number, active: boolean, origin: ReportingTemplateOrigin, lines: Array<Pick<ReportingTemplateLineInput, "scope" | "categoryCode">>) => ({
  version, active, origin, lineCount: lines.length,
  byScope: { "1": lines.filter((l) => l.scope === "1").length, "2": lines.filter((l) => l.scope === "2").length, "3": lines.filter((l) => l.scope === "3").length },
  toFile: lines.filter((l) => l.categoryCode === null).length,
});

async function requireClient(db: Queryable, organisationId: string, clientId: string): Promise<void> {
  const found = await db.query(`SELECT 1 FROM nzi_console.clients WHERE organisation_id = $1 AND client_id = $2`, [organisationId, clientId]);
  if (!found.rows[0]) throw new CommandValidationError([{ field: "clientId", code: "NOT_FOUND", message: "Client was not found." }]);
}

/** The latest version, checked against expectedVersion, and the lines it held (empty when withdrawn or none). */
async function latestChecked(db: Queryable, context: CommandContext, clientId: string, expectedVersion: number) {
  const latest = (await db.query<ReportingTemplateHeaderRow>(SELECT_LATEST_TEMPLATE, [context.organisationId, clientId])).rows[0] ?? null;
  if ((latest?.version ?? 0) !== expectedVersion) throw new VersionConflictError(expectedVersion, latest?.version ?? 0);
  const lines = latest?.active ? await readTemplateLines(db, context.organisationId, clientId, latest.version) : [];
  return { latest, lines };
}

/**
 * Each line's references are the client's own: a site of the client — and an archived site only if the template already
 * cited it (a line may keep an archived site, never be pointed at one: the ruled site-archive rule) — and a factor that
 * exists within its dataset. Categories are checked by the table (a foreign key and the scope CHECK) and the contract.
 */
async function checkLineReferences(db: Queryable, organisationId: string, clientId: string, lines: ReportingTemplateLineInput[], previousSites: Set<string>): Promise<void> {
  const issues: Array<{ field: string; code: string; message: string }> = [];
  for (const [index, line] of lines.entries()) {
    if (line.siteId) {
      const site = (await db.query<{ archived: boolean }>(`SELECT archived FROM nzi_console.client_sites WHERE organisation_id = $1 AND client_id = $2 AND site_id = $3`, [organisationId, clientId, line.siteId])).rows[0];
      if (!site) issues.push({ field: `lines[${index}].siteId`, code: "SITE_NOT_FOUND", message: `Line ${index + 1}: that site is not one of this client's.` });
      else if (site.archived && !previousSites.has(line.siteId)) issues.push({ field: `lines[${index}].siteId`, code: "SITE_ARCHIVED", message: `Line ${index + 1}: that site is archived — unarchive it to report against it.` });
    }
    if (line.categoryCode) {
      const category = await db.query(`SELECT 1 FROM nzi_console.input_spec_categories WHERE category_code = $1`, [line.categoryCode]);
      if (!category.rows[0]) issues.push({ field: `lines[${index}].categoryCode`, code: "CATEGORY_NOT_FOUND", message: `Line ${index + 1}: that category does not exist.` });
    }
    if (line.datasetId) {
      const found = line.factorId
        ? await db.query(`SELECT 1 FROM nzi_console.emission_factors WHERE organisation_id = $1 AND dataset_id = $2 AND factor_id = $3`, [organisationId, line.datasetId, line.factorId])
        : await db.query(`SELECT 1 FROM nzi_console.emission_factor_datasets WHERE organisation_id = $1 AND dataset_id = $2`, [organisationId, line.datasetId]);
      if (!found.rows[0]) issues.push({ field: `lines[${index}].${line.factorId ? "factorId" : "datasetId"}`, code: "FACTOR_NOT_FOUND", message: `Line ${index + 1}: that factor was not found.` });
    }
    if (issues.length >= 20) break;
  }
  if (issues.length) throw new CommandValidationError(issues);
}

/** Set the whole template, as the next version. */
export function setClientReportingTemplate(pool: PoolLike, input: CommandInputMap["client.reportingTemplate.set"], context: CommandContext): Promise<StoredOutcome<ReportingTemplateResult>> {
  return runPostgresCommand(pool, "client.reportingTemplate.set", input, context, async (db) => {
    await requireClient(db, context.organisationId, input.clientId);
    const { latest, lines: previous } = await latestChecked(db, context, input.clientId, input.expectedVersion);
    await checkLineReferences(db, context.organisationId, input.clientId, input.lines, new Set(previous.flatMap((line) => line.siteId ? [line.siteId] : [])));
    const version = input.expectedVersion + 1;
    await insertHeader(db, [context.organisationId, input.clientId, version, true, "manual", null, context.reason?.trim() || null, context.actorId, context.correlationId], input.expectedVersion);
    await insertLines(db, context.organisationId, input.clientId, version, input.lines);
    return {
      data: { clientId: input.clientId, ...summary(version, true, "manual", input.lines) },
      ...(latest ? { before: summary(latest.version, latest.active, latest.origin, previous) } : {}),
      entityType: "client_reporting_template", entityId: input.clientId, topic: "client.reporting_template.set",
    };
  });
}

type JobRowForTemplate = { scope: string; category_code: string | null; source_label: string | null; report_label: string | null; site_id: string | null; site_archived: boolean | null;
  dataset_id: string | null; factor_id: string | null; unit: string | null; origin: string };

/**
 * Initialise the next version from one of the client's CRP jobs: its enabled rows, one line per distinct activity (the
 * job's monthly invoices are one line, not twelve). A console row brings its category — or, for a Scope 3 row with none,
 * the category its scope names (3.1 → "3.1"), as roll-forward does. An imported v7 row comes in "to file": v7's rows carry
 * no category, and none is guessed. A factor is kept only when it is a dataset factor; an archived site is dropped (a
 * line is never pointed at an archived site).
 */
export function initialiseClientReportingTemplateFromJob(pool: PoolLike, input: CommandInputMap["client.reportingTemplate.initialiseFromJob"], context: CommandContext): Promise<StoredOutcome<ReportingTemplateResult & { jobId: string; jobNumber: string; archivedSitesDropped: number }>> {
  return runPostgresCommand(pool, "client.reportingTemplate.initialiseFromJob", input, context, async (db) => {
    await requireClient(db, context.organisationId, input.clientId);
    const job = (await db.query<{ job_number: string }>(
      `SELECT job_number FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 AND client_id = $3 AND job_family = 'crp'`,
      [context.organisationId, input.jobId, input.clientId])).rows[0];
    if (!job) throw new CommandValidationError([{ field: "jobId", code: "JOB_NOT_FOUND", message: "That is not one of this client's CRP jobs." }]);
    const { latest, lines: previous } = await latestChecked(db, context, input.clientId, input.expectedVersion);
    const { rows } = await db.query<JobRowForTemplate>(
      `SELECT r.scope, r.category_code, r.source_label, r.report_label, r.site_id, s.archived AS site_archived,
              CASE WHEN r.factor_source = 'dataset' THEN r.dataset_id END AS dataset_id,
              CASE WHEN r.factor_source = 'dataset' AND r.dataset_id IS NOT NULL THEN r.factor_id END AS factor_id, r.unit, r.origin
         FROM nzi_console.job_scope_rows r
         LEFT JOIN nzi_console.client_sites s ON (s.organisation_id, s.site_id) = (r.organisation_id, r.site_id)
        WHERE r.organisation_id = $1 AND r.job_id = $2 AND r.enabled = true
        ORDER BY left(r.scope, 1), lower(r.source_label), r.scope_row_id`, [context.organisationId, input.jobId]);
    const categories = new Set((await db.query<{ category_code: string }>(`SELECT category_code FROM nzi_console.input_spec_categories`)).rows.map((row) => row.category_code));
    const seen = new Set<string>();
    const lines: ReportingTemplateLineInput[] = [];
    let fromConsole = 0, archivedSitesDropped = 0;
    for (const row of rows) {
      const sourceLabel = row.source_label?.trim();
      if (!sourceLabel) continue;
      const scope = row.scope.slice(0, 1) as ReportingTemplateLineInput["scope"];
      const live = row.origin !== "migrated";
      const named = live ? (row.category_code?.trim() || (/^3\.\d+$/.test(row.scope) ? row.scope : null)) : null;
      const categoryCode = named && categories.has(named) && named.split(".")[0] === scope ? named : null;
      if (row.site_archived) archivedSitesDropped += 1;
      // A row's report label defaults to its source label; the line keeps one only when it says something different.
      const reportLabel = row.report_label?.trim() && row.report_label.trim() !== sourceLabel ? row.report_label.trim() : null;
      const line: ReportingTemplateLineInput = { scope, categoryCode, sourceLabel, reportLabel,
        siteId: row.site_archived ? null : row.site_id, datasetId: row.dataset_id, factorId: row.factor_id, unit: row.unit?.trim() || null };
      const key = JSON.stringify(line);
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
      if (live) fromConsole += 1;
    }
    if (lines.length === 0) throw new CommandValidationError([{ field: "jobId", code: "NOTHING_TO_COPY", message: `${job.job_number} has no enabled rows to build a template from.` }]);
    if (lines.length > REPORTING_TEMPLATE_MAX_LINES) throw new CommandValidationError([{ field: "jobId", code: "TOO_MANY", message: `${job.job_number} would make ${lines.length} lines; a template holds at most ${REPORTING_TEMPLATE_MAX_LINES}.` }]);
    // Scope order, then filed lines before "to file", keeping the source-label order within each.
    lines.sort((a, b) => a.scope.localeCompare(b.scope) || Number(a.categoryCode === null) - Number(b.categoryCode === null));
    const origin: ReportingTemplateOrigin = fromConsole > 0 ? "job" : "v7-import";
    const version = input.expectedVersion + 1;
    await insertHeader(db, [context.organisationId, input.clientId, version, true, origin, input.jobId, context.reason?.trim() || null, context.actorId, context.correlationId], input.expectedVersion);
    await insertLines(db, context.organisationId, input.clientId, version, lines);
    return {
      data: { clientId: input.clientId, ...summary(version, true, origin, lines), jobId: input.jobId, jobNumber: job.job_number, archivedSitesDropped },
      ...(latest ? { before: summary(latest.version, latest.active, latest.origin, previous) } : {}),
      entityType: "client_reporting_template", entityId: input.clientId, topic: "client.reporting_template.initialised",
    };
  });
}

/** Withdraw the template — a version that says so, with a reason and no lines. Never a delete. */
export function deactivateClientReportingTemplate(pool: PoolLike, input: CommandInputMap["client.reportingTemplate.deactivate"], context: CommandContext): Promise<StoredOutcome<ReportingTemplateResult>> {
  return runPostgresCommand(pool, "client.reportingTemplate.deactivate", input, context, async (db) => {
    await requireClient(db, context.organisationId, input.clientId);
    const { latest, lines: previous } = await latestChecked(db, context, input.clientId, input.expectedVersion);
    if (!latest) throw new CommandValidationError([{ field: "clientId", code: "NOT_FOUND", message: "This client has no reporting template to withdraw." }]);
    if (!latest.active) throw new CommandValidationError([{ field: "clientId", code: "ALREADY_INACTIVE", message: "The reporting template is already withdrawn." }]);
    const version = latest.version + 1;
    await insertHeader(db, [context.organisationId, input.clientId, version, false, "manual", null, context.reason!.trim(), context.actorId, context.correlationId], input.expectedVersion);
    return {
      data: { clientId: input.clientId, ...summary(version, false, "manual", []) },
      before: summary(latest.version, true, latest.origin, previous),
      entityType: "client_reporting_template", entityId: input.clientId, topic: "client.reporting_template.deactivated",
    };
  });
}
