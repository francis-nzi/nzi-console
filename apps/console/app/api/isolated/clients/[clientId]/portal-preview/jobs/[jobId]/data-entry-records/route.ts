import { authorizePortalPreviewJob } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../../../lib/isolatedDatabase";
import { portalPreviewGet, previewJson } from "../../../../../../../../lib/portalPreviewRoute";

export const dynamic = "force-dynamic";

/** `…/data-entry-records` in preview: what a portal user sent in their window — with no user, nothing. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    const { clientId, jobId } = await params;
    await authorizePortalPreviewJob(isolatedPool(), principal, clientId, jobId);
    return previewJson({ records: [] });
  });
}
