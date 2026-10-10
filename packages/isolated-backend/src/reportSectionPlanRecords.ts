// Reporting F-1 (0164): reading the client's report profile — shared by the profile commands and by `report.validate`, which
// seeds a version's plan from it (RULING-reporting-F Q3). Reads only; no command imports, so validate can use it.
import { defaultReportSectionPlan, type ClientReportProfile, type ReportSectionPlan } from "@nzi/contracts";
import type { Queryable } from "./postgres";

type ProfileRow = { version: number; active: boolean; section_plan: ReportSectionPlan | null; issuer_line: string | null; reason: string | null; set_by: string; set_at: Date | string };

/** Only `{ key, included }`, in order — what a plan is, and all that is stored or hashed. */
export const normaliseReportSectionPlan = (plan: ReportSectionPlan): ReportSectionPlan => plan.map(({ key, included }) => ({ key, included }));

const toProfile = (clientId: string, row: ProfileRow): ClientReportProfile => ({
  clientId, version: row.version, active: row.active, sectionPlan: row.section_plan, issuerLine: row.issuer_line, reason: row.reason,
  setBy: row.set_by, setAt: row.set_at instanceof Date ? row.set_at.toISOString() : String(row.set_at),
});

/** The client's latest profile version, withdrawn or not; null when it has never had one. */
export async function readLatestReportProfile(db: Queryable, organisationId: string, clientId: string): Promise<ClientReportProfile | null> {
  const row = (await db.query<ProfileRow>(
    `SELECT version, active, section_plan, issuer_line, reason, set_by, set_at FROM nzi_console.client_report_profiles
      WHERE organisation_id = $1 AND client_id = $2 ORDER BY version DESC LIMIT 1`, [organisationId, clientId])).rows[0];
  return row ? toProfile(clientId, row) : null;
}

/** The same, for a read model inside a tenant read: the tenant policy confines it to the organisation, as its siblings do. */
export async function readClientReportProfile(db: Queryable, clientId: string): Promise<ClientReportProfile | null> {
  const row = (await db.query<ProfileRow>(
    `SELECT version, active, section_plan, issuer_line, reason, set_by, set_at FROM nzi_console.client_report_profiles
      WHERE client_id = $1 ORDER BY version DESC LIMIT 1`, [clientId])).rows[0];
  return row ? toProfile(clientId, row) : null;
}

/** F-1b: a report version's section plan, as the preparation page holds it — the version publish will pin, and where it came from. */
export type ReportVersionSectionPlan = {
  reportVersionId: string; status: string; version: number; sectionPlan: ReportSectionPlan; origin: string; issuerLine: string | null;
};
export async function getReportVersionSectionPlan(db: Queryable, reportVersionId: string): Promise<ReportVersionSectionPlan | null> {
  const row = (await db.query<{ status: string; version: number; section_plan: ReportSectionPlan | null; section_plan_origin: string | null; client_issuer_line: string | null }>(
    `SELECT status, version, section_plan, section_plan_origin, client_issuer_line FROM nzi_console.report_versions WHERE report_version_id = $1`,
    [reportVersionId])).rows[0];
  if (!row) return null;
  // A version validated before 0164 holds no plan: it issues the default, and says so.
  return { reportVersionId, status: row.status, version: row.version, sectionPlan: row.section_plan ?? defaultReportSectionPlan,
    origin: row.section_plan_origin ?? "default", issuerLine: row.client_issuer_line };
}

/** The profile that seeds a version (Q3): the latest, when it is active. */
export async function readActiveReportProfile(db: Queryable, organisationId: string, clientId: string): Promise<{ version: number; sectionPlan: ReportSectionPlan; issuerLine: string | null } | null> {
  const latest = await readLatestReportProfile(db, organisationId, clientId);
  return latest?.active && latest.sectionPlan ? { version: latest.version, sectionPlan: latest.sectionPlan, issuerLine: latest.issuerLine } : null;
}
