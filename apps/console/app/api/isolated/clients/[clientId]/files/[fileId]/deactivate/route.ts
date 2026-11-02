import { adapterForProvider, deactivateClientFile } from "@nzi/isolated-backend";
import type { FileStorageProvider } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { requirePortalFiles, uploadFailure } from "../../../../../../../lib/fileUpload";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Withdraw a file (client.file.deactivate, with a reason): kept, never deleted. */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string; fileId: string }> }) {
  try {
    requirePortalFiles();
    const principal = await requireCommandPrincipal(request, "client.file.deactivate");
    const { clientId, fileId } = await params;
    return commandSuccess(await deactivateClientFile(isolatedPool(), { clientId, fileId }, commandContext(request, principal), (provider) => adapterForProvider(provider as FileStorageProvider)));
  } catch (error) { return uploadFailure(error) ?? commandFailure(error); }
}
