import { getPortalPublishedReportForStaff } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../../../lib/isolatedDatabase";
import { portalPreviewGet, previewJson } from "../../../../../../../../lib/portalPreviewRoute";
import { isPublishedCrpReport } from "../../../../../../../../portal/jobs/[jobId]/publishedReportValidation";

export const dynamic = "force-dynamic";

/**
 * The published report in preview (`/api/portal/jobs/{jobId}/published-report`): the client's copy, selected as the client's is
 * (`portalPublishedReportOf`), with no approval — an approval is a portal user's, and nobody is signed in as one here.
 */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    const { clientId, jobId } = await params;
    const wanted = new URL(request.url).searchParams.get("reportVersionId");
    const result = await getPortalPublishedReportForStaff(isolatedPool(), principal, clientId, jobId, wanted);
    if (!result) return previewJson({ code: "NOT_FOUND", message: "No published report is available." }, 404);
    if (!isPublishedCrpReport(result.report, jobId)) return previewJson({ code: "INVALID_PUBLISHED_EVIDENCE", message: "The published report evidence could not be verified." }, 502);
    return previewJson(result);
  });
}
