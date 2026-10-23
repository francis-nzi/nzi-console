import { listPortalBroadcastsForStaff } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { portalPreviewGet, previewJson } from "../../../../../../lib/portalPreviewRoute";

export const dynamic = "force-dynamic";

/** The broadcasts live for this client (`/api/portal/broadcasts`), from the client's own resolver. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    const { clientId } = await params;
    return previewJson({ broadcasts: await listPortalBroadcastsForStaff(isolatedPool(), principal, clientId) });
  });
}
