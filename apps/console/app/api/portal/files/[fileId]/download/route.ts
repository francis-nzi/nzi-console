import { adapterForProvider, issuePortalFileDownload } from "@nzi/isolated-backend";
import type { FileStorageProvider } from "@nzi/contracts";
import { requirePortalFiles, uploadFailure } from "../../../../../lib/fileUpload";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { portalCommandContext, portalCommandFailure } from "../../../../../lib/portalCommand";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/** One audited access (portal.file.download): a signed, time-limited URL for a released file the client is entitled to — never a durable link. */
export async function POST(request: Request, { params }: { params: Promise<{ fileId: string }> }) {
  try {
    requirePortalFiles();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { fileId } = await params;
    const { outcome, download } = await issuePortalFileDownload(isolatedPool(), { clientId: user.clientId, fileId }, portalCommandContext(request, user), (provider) => adapterForProvider(provider as FileStorageProvider));
    if (!download) return Response.json({ code: "REPLAYED", message: "That access was already recorded; ask for the file again." }, { status: 409 });
    return Response.json({ ...download, auditEventId: outcome.auditEventId }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return uploadFailure(error) ?? portalCommandFailure(error); }
}
