// Reporting F-1 (0164): reading the client's report profile — shared by the profile commands and by `report.validate`, which
// seeds a version's plan from it (RULING-reporting-F Q3). Reads only; no command imports, so validate can use it.
import type { ClientReportProfile, ReportSectionPlan } from "@nzi/contracts";
import type { Queryable } from "./postgres";

type ProfileRow = { version: number; active: boolean; section_plan: ReportSectionPlan | null; issuer_line: string | null; reason: string | null; set_by: string; set_at: Date | string };

/** Only `{ key, included }`, in order — what a plan is, and all that is stored or hashed. */
export const normaliseReportSectionPlan = (plan: ReportSectionPlan): ReportSectionPlan => plan.map(({ key, included }) => ({ key, included }));

/** The client's latest profile version, withdrawn or not; null when it has never had one. */
export async function readLatestReportProfile(db: Queryable, organisationId: string, clientId: string): Promise<ClientReportProfile | null> {
  const row = (await db.query<ProfileRow>(
    `SELECT version, active, section_plan, issuer_line, reason, set_by, set_at FROM nzi_console.client_report_profiles
      WHERE organisation_id = $1 AND client_id = $2 ORDER BY version DESC LIMIT 1`, [organisationId, clientId])).rows[0];
  if (!row) return null;
  return { clientId, version: row.version, active: row.active, sectionPlan: row.section_plan, issuerLine: row.issuer_line, reason: row.reason,
    setBy: row.set_by, setAt: row.set_at instanceof Date ? row.set_at.toISOString() : String(row.set_at) };
}

/** The profile that seeds a version (Q3): the latest, when it is active. */
export async function readActiveReportProfile(db: Queryable, organisationId: string, clientId: string): Promise<{ version: number; sectionPlan: ReportSectionPlan; issuerLine: string | null } | null> {
  const latest = await readLatestReportProfile(db, organisationId, clientId);
  return latest?.active && latest.sectionPlan ? { version: latest.version, sectionPlan: latest.sectionPlan, issuerLine: latest.issuerLine } : null;
}
