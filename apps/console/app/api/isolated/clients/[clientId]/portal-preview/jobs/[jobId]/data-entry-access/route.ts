import { authorizePortalPreviewJob } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../../../lib/isolatedDatabase";
import { portalPreviewGet, previewJson } from "../../../../../../../../lib/portalPreviewRoute";

export const dynamic = "force-dynamic";

/**
 * `…/data-entry-access` in preview. A data-entry window belongs to a portal user's grant, and a preview has no portal user, so
 * the answer is the one a user with no window gets: none. It never gates the preview (R2) — the preview is read-only throughout.
 */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string; jobId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    const { clientId, jobId } = await params;
    await authorizePortalPreviewJob(isolatedPool(), principal, clientId, jobId);
    return previewJson({ access: null, buckets: [] });
  });
}
