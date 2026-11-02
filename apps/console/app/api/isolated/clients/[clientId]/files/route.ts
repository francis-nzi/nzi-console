import { configuredStorageAdapter, ingestFile, listPortalFilesForStaff, recordClientFileDelivery } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { readUpload, requirePortalFiles, uploadFailure, withdrawIfReplayed } from "../../../../../lib/fileUpload";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** The Files tab: every file for this client in both directions and every state, under portal.admin on the client. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    requirePortalFiles();
    const principal = await currentStaff(request);
    const { clientId } = await params;
    return Response.json({ files: await listPortalFilesForStaff(isolatedPool(), principal, clientId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return uploadFailure(error) ?? authFailure(error); }
}

/** Share a file with the client (client.file.deliver): through the same gate as a client's upload. Form fields: file, jobId (optional). */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    requirePortalFiles();
    const principal = await requireCommandPrincipal(request, "client.file.deliver");
    const { clientId } = await params;
    const { fileName, bytes, fields } = await readUpload(request);
    const adapter = configuredStorageAdapter();
    const ingest = await ingestFile({ adapter, organisationId: principal.organisationId, clientId, jobId: String(fields.get("jobId") ?? "").trim() || null, fileName, bytes });
    const outcome = await recordClientFileDelivery(isolatedPool(), { clientId, ingest }, commandContext(request, principal));
    await withdrawIfReplayed(adapter, ingest, outcome.replayed);
    return commandSuccess(outcome);
  } catch (error) { return uploadFailure(error) ?? commandFailure(error); }
}
