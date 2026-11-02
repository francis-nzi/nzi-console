import { adapterForProvider, issueClientFileDownload } from "@nzi/isolated-backend";
import type { FileStorageProvider } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure } from "../../../../../../../lib/commandResponse";
import { requirePortalFiles, uploadFailure } from "../../../../../../../lib/fileUpload";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** One audited access (client.file.download): a signed, time-limited URL for a released file. */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string; fileId: string }> }) {
  try {
    requirePortalFiles();
    const principal = await requireCommandPrincipal(request, "client.file.download");
    const { clientId, fileId } = await params;
    const { outcome, download } = await issueClientFileDownload(isolatedPool(), { clientId, fileId }, commandContext(request, principal), (provider) => adapterForProvider(provider as FileStorageProvider));
    if (!download) return Response.json({ code: "REPLAYED", message: "That access was already recorded; ask for the file again." }, { status: 409 });
    return Response.json({ ...download, auditEventId: outcome.auditEventId }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return uploadFailure(error) ?? commandFailure(error); }
}
