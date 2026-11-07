import { getGrantedPortalReviewRound, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { portalFeatureEnabled } from "../../../../../lib/portalFlags";
import { currentPortalUserForData } from "../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Client-review loop S4: the round open for this client's review on a job - the live composition (stored nowhere) and the narrative
 * sections they may edit. `?reportVersionId=` names the scope's round. 404 when the flag is off or there is no round for this user.
 * Read only.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    if (!portalFeatureEnabled("portal-report-review")) return Response.json({ code: "NOT_FOUND", message: "Not found." }, { status: 404 });
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const reportVersionId = new URL(request.url).searchParams.get("reportVersionId");
    const round = await withTenantRead(isolatedPool(), user.organisationId, (db) => getGrantedPortalReviewRound(db, { organisationId: user.organisationId, portalUserId: user.userId, clientId: user.clientId, jobId, reportVersionId }));
    const headers = { "Cache-Control": "private, no-store" };
    if (!round) return Response.json({ code: "NOT_FOUND", message: "No report is open for your review." }, { status: 404, headers });
    return Response.json({ round }, { headers });
  } catch (error) { return portalAuthFailure(error); }
}
