import { listPortalPreviewJobs } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { portalPreviewGet, previewJson } from "../../../../../../lib/portalPreviewRoute";

export const dynamic = "force-dynamic";

/** The client's portfolio in preview (`/api/portal/jobs`): the client's own jobs, never its grants (R3). */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    const { clientId } = await params;
    return previewJson({ jobs: await listPortalPreviewJobs(isolatedPool(), principal, clientId) });
  });
}
