import { getPortalFileHistory } from "@nzi/isolated-backend";
import { requirePortalFiles, uploadFailure } from "../../../../../lib/fileUpload";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { portalCommandFailure } from "../../../../../lib/portalCommand";
import { currentPortalUserForData } from "../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/** One file's History for the signed-in client user who is entitled to the file: who (you, a colleague, NZI) and when. Read-only; no staff name, no storage id. */
export async function GET(request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    requirePortalFiles();
    const user = await currentPortalUserForData(request);
    const { fileId } = await params;
    return Response.json({ history: await getPortalFileHistory(isolatedPool(), user, fileId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return uploadFailure(error) ?? portalCommandFailure(error); }
}
