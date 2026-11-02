import { adapterForProvider, configuredScanner, rescanClientFile } from "@nzi/isolated-backend";
import type { FileStorageProvider } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { requirePortalFiles, uploadFailure } from "../../../../../../../lib/fileUpload";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Scan a held file again (client.file.rescan): released, refused, or still held. */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string; fileId: string }> }) {
  try {
    requirePortalFiles();
    const principal = await requireCommandPrincipal(request, "client.file.rescan");
    const { clientId, fileId } = await params;
    return commandSuccess(await rescanClientFile(isolatedPool(), { clientId, fileId }, commandContext(request, principal), (provider) => adapterForProvider(provider as FileStorageProvider), configuredScanner()));
  } catch (error) { return uploadFailure(error) ?? commandFailure(error); }
}
