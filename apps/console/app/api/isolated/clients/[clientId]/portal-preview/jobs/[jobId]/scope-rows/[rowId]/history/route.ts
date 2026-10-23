import { getPortalRowHistoryForStaff } from "@nzi/isolated-backend";
import { isolatedPool } from "../../../../../../../../../../lib/isolatedDatabase";
import { requirePortalData } from "../../../../../../../../../../lib/portalCommand";
import { portalPreviewGet, previewJson } from "../../../../../../../../../../lib/portalPreviewRoute";

export const dynamic = "force-dynamic";

/** A row's History as the client sees it — "you" or "your adviser", never a name — in preview. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string; jobId: string; rowId: string }> }) {
  return portalPreviewGet(request, async (principal) => {
    requirePortalData();
    const { clientId, jobId, rowId } = await params;
    return previewJson({ history: await getPortalRowHistoryForStaff(isolatedPool(), principal, clientId, jobId, rowId) });
  });
}
