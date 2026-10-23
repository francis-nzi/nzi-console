import { listReportCommentsForStaff } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../../../../lib/isolatedDatabase";
import { portalPreviewGet, previewJson } from "../../../../../../../../../lib/portalPreviewRoute";

export const dynamic = "force-dynamic";

/**
 * A published report's message thread in preview (`/api/portal/jobs/{jobId}/published-report/comments`, GET only): read only —
 * there is no reply and no read receipt from the preview; both are a portal user's.
 */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    const { clientId, jobId } = await params;
    const reportVersionId = new URL(request.url).searchParams.get("reportVersionId")?.trim() ?? "";
    if (!reportVersionId) return previewJson({ code: "INVALID_REPORT_COMMENTS", message: "A published report version is required." }, 422);
    return previewJson({ comments: await listReportCommentsForStaff(isolatedPool(), principal, clientId, jobId, reportVersionId) });
  });
}
