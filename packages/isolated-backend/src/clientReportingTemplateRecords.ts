// Phase 1c (0159) — reading a client's reporting template. Kept apart from the commands so the read models can use it
// without importing the command runner.
import type { ClientReportingTemplate, ClientReportingTemplateReadModel, ReportingTemplateLine, ReportingTemplateOrigin, ReportingTemplateScope } from "@nzi/contracts";
import type { Queryable } from "./postgres";

export type ReportingTemplateHeaderRow = { version: number; active: boolean; origin: ReportingTemplateOrigin; origin_ref: string | null; set_by: string; set_at: Date | string };

export const SELECT_LATEST_TEMPLATE = `SELECT version, active, origin, origin_ref, set_by, set_at
  FROM nzi_console.client_reporting_templates WHERE organisation_id = $1 AND client_id = $2 ORDER BY version DESC LIMIT 1`;

/** A version's lines, in order, with the category's name, the site's name and the factor's label read for display. */
export async function readTemplateLines(db: Queryable, organisationId: string, clientId: string, version: number): Promise<ReportingTemplateLine[]> {
  const { rows } = await db.query<{ line_id: string; scope: ReportingTemplateScope; category_code: string | null; source_label: string; report_label: string | null;
    site_id: string | null; dataset_id: string | null; factor_id: string | null; unit: string | null; ordering: number; category_name: string | null; site_name: string | null; factor_label: string | null }>(
    `SELECT l.line_id, l.scope, l.category_code, l.source_label, l.report_label, l.site_id, l.dataset_id, l.factor_id, l.unit, l.ordering,
            c.name AS category_name, s.name AS site_name, f.label AS factor_label
       FROM nzi_console.client_reporting_template_lines l
       LEFT JOIN nzi_console.input_spec_categories c ON c.category_code = l.category_code
       LEFT JOIN nzi_console.client_sites s ON (s.organisation_id, s.site_id) = (l.organisation_id, l.site_id)
       LEFT JOIN nzi_console.emission_factors f ON (f.organisation_id, f.dataset_id, f.factor_id) = (l.organisation_id, l.dataset_id, l.factor_id)
      WHERE l.organisation_id = $1 AND l.client_id = $2 AND l.version = $3
      ORDER BY l.ordering, l.line_id`, [organisationId, clientId, version]);
  return rows.map((row) => ({
    lineId: row.line_id, ordering: row.ordering, scope: row.scope, categoryCode: row.category_code, sourceLabel: row.source_label, reportLabel: row.report_label,
    siteId: row.site_id, datasetId: row.dataset_id, factorId: row.factor_id, unit: row.unit,
    categoryName: row.category_name, siteName: row.site_name, factorLabel: row.factor_label,
  }));
}

/**
 * The client's template in force — the latest version, when active, with its lines — and the latest version number, so
 * the card's next write can pass it as expectedVersion. A withdrawn template reads as none.
 */
export async function getClientReportingTemplate(db: Queryable, clientId: string): Promise<ClientReportingTemplateReadModel> {
  const header = (await db.query<ReportingTemplateHeaderRow & { organisation_id: string; origin_job_number: string | null }>(
    `SELECT t.organisation_id, t.version, t.active, t.origin, t.origin_ref, t.set_by, t.set_at, j.job_number AS origin_job_number
       FROM nzi_console.client_reporting_templates t
       LEFT JOIN nzi_console.jobs j ON (j.organisation_id, j.job_id) = (t.organisation_id, t.origin_ref)
      WHERE t.client_id = $1 ORDER BY t.version DESC LIMIT 1`, [clientId])).rows[0];
  if (!header) return { current: null, latestVersion: 0 };
  if (!header.active) return { current: null, latestVersion: header.version };
  const current: ClientReportingTemplate = {
    version: header.version, origin: header.origin, originJobNumber: header.origin_job_number, setBy: header.set_by,
    setAt: header.set_at instanceof Date ? header.set_at.toISOString() : String(header.set_at),
    lines: await readTemplateLines(db, header.organisation_id, clientId, header.version),
  };
  return { current, latestVersion: header.version };
}

/** The categories a line may be filed under: the active input-spec categories, by scope and name. */
export async function listReportingTemplateCategories(db: Queryable): Promise<Array<{ code: string; scope: ReportingTemplateScope; name: string }>> {
  const { rows } = await db.query<{ category_code: string; scope: ReportingTemplateScope; name: string }>(
    `SELECT category_code, scope, name FROM nzi_console.input_spec_categories WHERE active = true ORDER BY scope, name`);
  return rows.map((row) => ({ code: row.category_code, scope: row.scope, name: row.name }));
}
