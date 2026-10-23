import { getPortalInputSpecForStaff } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { portalPreviewGet, previewJson } from "../../../../../../lib/portalPreviewRoute";

export const dynamic = "force-dynamic";

/** The input spec as this client sees it (`/api/portal/input-spec`), from the client's own resolver. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    const { clientId } = await params;
    return previewJson({ spec: await getPortalInputSpecForStaff(isolatedPool(), principal, clientId) });
  });
}
