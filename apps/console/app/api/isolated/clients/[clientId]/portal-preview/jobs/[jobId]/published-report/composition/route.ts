import { getPortalReportViewForStaff } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../../../../lib/isolatedDatabase";
import { portalPreviewGet, previewJson } from "../../../../../../../../../lib/portalPreviewRoute";

export const dynamic = "force-dynamic";

/** The frozen composition in preview (`…/published-report/composition`): read back, never rebuilt; the client's copy (D6). */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    const { clientId, jobId } = await params;
    const reportVersionId = new URL(request.url).searchParams.get("reportVersionId");
    const view = await getPortalReportViewForStaff(isolatedPool(), principal, clientId, jobId, reportVersionId);
    if (!view) return previewJson({ code: "NOT_FOUND", message: "No published report is available." }, 404);
    if (view.state === "pre-composition") return previewJson({ state: "pre-composition", reportVersionId: view.report.reportVersionId });
    // The frozen document must be this version's, of this job — or nothing is shown.
    if (view.composition.reportVersionId !== view.report.reportVersionId || view.composition.jobId !== jobId) {
      return previewJson({ code: "INVALID_PUBLISHED_EVIDENCE", message: "The published report could not be verified." }, 502);
    }
    return previewJson({ state: "composed", reportVersionId: view.report.reportVersionId, composition: view.composition });
  });
}
