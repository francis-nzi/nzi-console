import { getGrantedPortalReport, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Reporting F-4a (RULING-reporting-F4): the frozen composition of a published report, for the client — read back, never
 * rebuilt. `?reportVersionId=` names the scope's report (S-1's switcher), else the default. A version issued before
 * compositions were frozen answers `pre-composition` (D1): its snapshot render, from the published-report route, stands.
 * Internal strategy owners are left out of the client's copy (D6). Read only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const reportVersionId = new URL(request.url).searchParams.get("reportVersionId");
    const view = await withTenantRead(isolatedPool(), user.organisationId, (db) => getGrantedPortalReport(db, { portalUserId: user.userId, clientId: user.clientId, jobId, reportVersionId }));
    const headers = { "Cache-Control": "private, no-store" };
    if (!view) return Response.json({ code: "NOT_FOUND", message: "No published report is available." }, { status: 404, headers });
    if (view.state === "pre-composition") return Response.json({ state: "pre-composition", reportVersionId: view.report.reportVersionId }, { headers });
    // The frozen document must be this version's, of this job — or nothing is shown.
    if (view.composition.reportVersionId !== view.report.reportVersionId || view.composition.jobId !== jobId) {
      return Response.json({ code: "INVALID_PUBLISHED_EVIDENCE", message: "The published report could not be verified." }, { status: 502, headers });
    }
    return Response.json({ state: "composed", reportVersionId: view.report.reportVersionId, composition: view.composition }, { headers });
  } catch (error) { return portalAuthFailure(error); }
}
