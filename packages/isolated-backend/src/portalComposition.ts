// Reporting F-4a (RULING-reporting-F4 D1, D4, D6) — what a client sees of a published report: the frozen composition, never a
// re-resolve of the snapshot. Every read is grant-checked as the portal's other reads are (the grant to the job, the version
// published and this job's), inside the tenant read the route opens.
//
// A version issued before compositions were frozen (pre-0077) has none, and none is ever made for it (D1: composing today's
// records into a "frozen" report would fabricate a freeze). It is returned as `pre-composition`, for the labelled snapshot render.
import { clientFacingComposition, type PublishedCrpReportReadModel, type ReportComposition } from "@nzi/contracts";
import type { ClientLogoAsset } from "./clientLogo";
import { readOrganisationLogoAsset } from "./organisationSettings";
import type { Queryable } from "./postgres";
import { getGrantedPublishedCrpReport, listGrantedPublishedCrpReports } from "./readModels";
import { getReportComposition } from "./reportCompositions";

export type PortalReportView =
  | { state: "composed"; report: PublishedCrpReportReadModel; composition: ReportComposition }
  | { state: "pre-composition"; report: PublishedCrpReportReadModel };

/**
 * D6 + F-4b: the client's copy carries no internal owner of a reduction action and no reviewer. Defined in contracts (pure),
 * so the staff preview of the client's view applies the same strip; re-exported here for the portal read.
 */
export { clientFacingComposition };

/**
 * The report a portal user may see: the version named (only if it is a published report of this job, under their grant), else
 * the default — whole-client first, then the most recently published (S-1, ruled). Null when there is none to see.
 */
export async function getGrantedPortalReport(db: Queryable, input: { portalUserId: string; clientId: string; jobId: string; reportVersionId?: string | null }): Promise<PortalReportView | null> {
  const report = await getGrantedPublishedCrpReport(db, input);
  if (!report) return null;
  const composition = await getReportComposition(db, report.reportVersionId);
  return composition ? { state: "composed", report, composition: clientFacingComposition(composition) } : { state: "pre-composition", report };
}

/**
 * D4: the issuing organisation's logo, as a version froze it — served to a portal user only when it is the issuer logo of a
 * published report of a job they hold a grant to. Never any other organisation asset.
 */
export async function getGrantedIssuerLogo(db: Queryable, input: { organisationId: string; portalUserId: string; clientId: string; jobId: string; assetId: string }): Promise<ClientLogoAsset | null> {
  const reports = await listGrantedPublishedCrpReports(db, input);
  if (!reports.some((report) => report.issuer?.logoAssetId === input.assetId)) return null;
  return readOrganisationLogoAsset(db, input.organisationId, input.assetId);
}
