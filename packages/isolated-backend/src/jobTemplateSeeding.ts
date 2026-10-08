// Redesign Phase 3b (0162, ruled 8 Oct 2026: RULING-phase3-design.md #7–#11) — a job's entry rows, seeded from its
// client's reporting template (`client_reporting_templates`, 0159).
//
// The inverse of `client.reportingTemplate.initialiseFromJob`: each line of the active template version becomes a scope
// row — its shape (scope, category, labels, site, factor, unit), never a figure — and the job's config row records which
// version seeded it. Run by `job.seedFromTemplate` (a person, any time) and inside `job.create` for a CRP job whose client
// has an active template.
//
// Every line goes through the scope-row create itself (`createScopeRowInTransaction`), inside its own savepoint, so
// seeding cannot create a row a person could not: the same validation, authorisation, declared factor, JW-9 factor rule,
// site rules and unit check, the same insert, audit and outbox. A line that write refuses is rolled back to its savepoint
// and counted by its refusal code; it never fails the seed (ruled #9).
import type { CommandContext, CommandInputMap, JobTemplateSeedingReadModel, ReportingTemplateLine, TemplateSeedResult } from "@nzi/contracts";
import { VersionConflictError } from "./errors";
import type { PoolLike, Queryable } from "./postgres";
import { readTemplateLines, SELECT_LATEST_TEMPLATE, type ReportingTemplateHeaderRow } from "./clientReportingTemplateRecords";
import { CommandValidationError, createScopeRowInTransaction, runPostgresCommand, runPostgresCommandInTransaction, type StoredOutcome } from "./postgresCommands";
import { listExcludedSiteIds } from "./siteInclusionGuard";

const refuse = (field: string, code: string, message: string) => new CommandValidationError([{ field, code, message }]);

/** A row's identity for "already on the job" (ruled: scope + category + source label + site; NULL equals NULL). */
const rowKey = (scope: string, categoryCode: string | null, sourceLabel: string, siteId: string | null) =>
  JSON.stringify([scope, categoryCode ?? null, sourceLabel.trim(), siteId ?? null]);

/**
 * The factor a line carries into this job (ruled #8): the **same factor id in a dataset selected for this job** —
 * uk-ghg ids are stable across editions, so this is the normal case, priced at this year's values. Never the line's own
 * (last year's) edition unless the job has selected it; never a manual selection added to make it fit. Null when the
 * job's editions do not carry it, so the declared factor (where its category is switched on) fills it in the create, or
 * the create refuses it (FACTOR_REQUIRED) and it is counted as unresolved.
 */
async function factorInJobEditions(db: Queryable, organisationId: string, jobId: string, line: ReportingTemplateLine) {
  if (!line.factorId) return null;
  const { rows: [found] } = await db.query<{ dataset_id: string; label: string; version: string; activity_unit: string | null }>(
    `SELECT s.dataset_id, f.label, d.version, f.activity_unit
       FROM nzi_console.job_dataset_selections s
       JOIN nzi_console.emission_factors_display f ON (f.organisation_id, f.dataset_id) = (s.organisation_id, s.dataset_id)
       JOIN nzi_console.emission_factor_datasets d ON (d.organisation_id, d.dataset_id) = (s.organisation_id, s.dataset_id)
      WHERE s.organisation_id = $1 AND s.job_id = $2 AND f.factor_id = $3 AND f.active
      ORDER BY (s.dataset_id = $4) DESC, s.dataset_id
      LIMIT 1`,
    [organisationId, jobId, line.factorId, line.datasetId ?? ""]);
  return found ? { datasetId: found.dataset_id, factorId: line.factorId, factorVersion: found.version, factorLabel: found.label, unit: found.activity_unit } : null;
}

/** The handler both the command and the auto-seed run: lock, read, write each line through the create, record. */
function seedHandler(input: CommandInputMap["job.seedFromTemplate"], context: CommandContext) {
  return async (db: Queryable) => {
    // The job row, locked: serialises seeds of one job (no duplicate rows from two at once), and against 3a's inclusion
    // change and job.update's period move. Each line's create then takes the same row FOR SHARE — already held.
    const { rows: [job] } = await db.query<{ client_id: string; job_family: string }>(
      `SELECT client_id, job_family FROM nzi_console.jobs WHERE organisation_id = $1 AND job_id = $2 FOR UPDATE`, [context.organisationId, input.jobId]);
    if (!job) throw refuse("jobId", "NOT_FOUND", "Job was not found.");
    if (job.job_family !== "crp") throw refuse("jobId", "NOT_CRP", "Only a carbon reporting job is seeded from a reporting template.");
    const { rows: [config] } = await db.query<{ seeded_template_version: number | null }>(
      `SELECT seeded_template_version FROM nzi_console.job_emissions_config WHERE organisation_id = $1 AND job_id = $2`, [context.organisationId, input.jobId]);
    if (!config) throw refuse("jobId", "CONFIG_MISSING", "Set the job's reporting period first — a job is seeded once it has one.");

    const header = (await db.query<ReportingTemplateHeaderRow>(SELECT_LATEST_TEMPLATE, [context.organisationId, job.client_id])).rows[0];
    if (!header || !header.active) throw refuse("expectedTemplateVersion", "NO_TEMPLATE", "This client has no reporting template in force to seed from.");
    // Ruled #7: nobody seeds a template version they have not seen.
    if (header.version !== input.expectedTemplateVersion) throw new VersionConflictError(input.expectedTemplateVersion, header.version);

    const lines = await readTemplateLines(db, context.organisationId, job.client_id, header.version);
    const existing = new Set((await db.query<{ scope: string; category_code: string | null; source_label: string; site_id: string | null }>(
      `SELECT scope, category_code, source_label, site_id FROM nzi_console.job_scope_rows WHERE organisation_id = $1 AND job_id = $2`,
      [context.organisationId, input.jobId])).rows.map((row) => rowKey(row.scope, row.category_code, row.source_label, row.site_id)));
    const archived = new Set((await db.query<{ site_id: string }>(
      `SELECT site_id FROM nzi_console.client_sites WHERE organisation_id = $1 AND client_id = $2 AND archived`, [context.organisationId, job.client_id])).rows.map((row) => row.site_id));
    const excluded = await listExcludedSiteIds(db, input.jobId);

    const result: TemplateSeedResult = { jobId: input.jobId, templateVersion: header.version, seeded: 0, skipped: {}, siteDropped: 0 };
    const skip = (why: string) => { result.skipped[why] = (result.skipped[why] ?? 0) + 1; };

    for (const line of lines) {
      // A Scope 3 line not yet filed under a category has no row scope a row can take (crpScopeOptions is 3.1…3.15).
      if (line.scope === "3" && !line.categoryCode) { skip("toFile"); continue; }
      const scope = line.scope === "3" ? line.categoryCode! : line.scope;
      // An archived site, or one this job leaves out (3a), is not carried: the line is seeded without a site.
      const siteDropped = !!line.siteId && (archived.has(line.siteId) || excluded.has(line.siteId));
      if (siteDropped) result.siteDropped += 1;
      const siteId = siteDropped ? null : line.siteId;
      const key = rowKey(scope, line.categoryCode, line.sourceLabel, siteId);
      if (existing.has(key)) { skip("duplicate"); continue; }

      const factor = await factorInJobEditions(db, context.organisationId, input.jobId, line);
      const row: CommandInputMap["scope.row.create"] = {
        jobId: input.jobId, scope, categoryCode: line.categoryCode, sourceLabel: line.sourceLabel, reportLabel: line.reportLabel,
        siteId, quantity: null, unit: line.unit ?? factor?.unit ?? null,
        datasetId: factor?.datasetId ?? null, factorId: factor?.factorId ?? null, factorVersion: factor?.factorVersion ?? null, factorLabel: factor?.factorLabel ?? null,
        qualityTier: null,
      };
      // Each line is its own scope.row.create — its own idempotency key, under the seed's correlation — so a refusal
      // rolls back only that line, and a seeded row carries the same audit trail as one made by hand.
      const lineContext: CommandContext = { ...context, idempotencyKey: `${context.idempotencyKey}:line:${line.lineId}`, reason: undefined };
      await db.query("SAVEPOINT seed_line");
      try {
        await createScopeRowInTransaction(db, row, lineContext);
        await db.query("RELEASE SAVEPOINT seed_line");
        result.seeded += 1;
        existing.add(key);
      } catch (error) {
        await db.query("ROLLBACK TO SAVEPOINT seed_line");
        await db.query("RELEASE SAVEPOINT seed_line");
        if (!(error instanceof CommandValidationError)) throw error;
        skip(error.issues[0]?.code ?? "REFUSED");
      }
    }

    await db.query(
      `UPDATE nzi_console.job_emissions_config SET seeded_template_version = $3, seeded_at = now() WHERE organisation_id = $1 AND job_id = $2`,
      [context.organisationId, input.jobId, header.version]);
    return {
      // NZC-120: counts only — no label, unit, quantity or money.
      data: result,
      before: { seededTemplateVersion: config.seeded_template_version },
      entityType: "job", entityId: input.jobId, topic: "job.seeded_from_template",
    };
  };
}

/** `job.seedFromTemplate` — a person seeds (or re-seeds, filling gaps) from the version they were shown. */
export function seedJobFromTemplate(pool: PoolLike, input: CommandInputMap["job.seedFromTemplate"], context: CommandContext): Promise<StoredOutcome<TemplateSeedResult>> {
  return runPostgresCommand(pool, "job.seedFromTemplate", input, context, seedHandler(input, context));
}

/**
 * The auto-seed inside `job.create` (ruled): when the client has a template in force, the new CRP job is seeded from it
 * in the same transaction — after its config row and automatic datasets exist, so lines resolve against this year's
 * editions. No template, nothing done; a line refused is skipped, never failing the create. Runs as the command itself,
 * so it is audited and idempotent like one (its key derived from the create's).
 */
export async function autoSeedNewJobInTransaction(db: Queryable, jobId: string, clientId: string, context: CommandContext): Promise<TemplateSeedResult | null> {
  const header = (await db.query<ReportingTemplateHeaderRow>(SELECT_LATEST_TEMPLATE, [context.organisationId, clientId])).rows[0];
  if (!header?.active) return null;
  const input = { jobId, expectedTemplateVersion: header.version };
  const seedContext: CommandContext = { ...context, idempotencyKey: `${context.idempotencyKey}:seed`, reason: undefined };
  return (await runPostgresCommandInTransaction(db, "job.seedFromTemplate", input, seedContext, seedHandler(input, seedContext))).data;
}

/** The job's side of its client's template, for the Setup drawer: what is in force, and which version last seeded it. */
export async function getJobTemplateSeeding(db: Queryable, jobId: string): Promise<JobTemplateSeedingReadModel | null> {
  const { rows: [job] } = await db.query<{ organisation_id: string; client_id: string; configured: boolean; seeded_template_version: number | null; seeded_at: Date | string | null }>(
    `SELECT j.organisation_id, j.client_id, (c.job_id IS NOT NULL) AS configured, c.seeded_template_version, c.seeded_at
       FROM nzi_console.jobs j LEFT JOIN nzi_console.job_emissions_config c ON (c.organisation_id, c.job_id) = (j.organisation_id, j.job_id)
      WHERE j.job_id = $1`, [jobId]);
  if (!job) return null;
  const header = (await db.query<ReportingTemplateHeaderRow>(SELECT_LATEST_TEMPLATE, [job.organisation_id, job.client_id])).rows[0];
  const inForce = header?.active ? header.version : null;
  const lineCount = inForce === null ? 0 : Number((await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM nzi_console.client_reporting_template_lines WHERE organisation_id = $1 AND client_id = $2 AND version = $3`,
    [job.organisation_id, job.client_id, inForce])).rows[0]!.n);
  return {
    templateVersion: inForce, lineCount, configured: job.configured,
    seededTemplateVersion: job.seeded_template_version,
    seededAt: job.seeded_at === null ? null : job.seeded_at instanceof Date ? job.seeded_at.toISOString() : String(job.seeded_at),
  };
}
