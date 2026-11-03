import { configuredScanner, configuredStorageAdapter, ingestFile, listPortalFiles, recordPortalFileUpload } from "@nzi/isolated-backend";
import type { PortalFileCategory } from "@nzi/contracts";
import { commandSuccess } from "../../../lib/commandResponse";
import { readUpload, requirePortalFiles, uploadFailure, withdrawIfReplayed } from "../../../lib/fileUpload";
import { isolatedPool } from "../../../lib/isolatedDatabase";
import { portalCommandContext, portalCommandFailure } from "../../../lib/portalCommand";
import { currentPortalUserForData, requirePortalOrigin } from "../../../lib/portalSession";

export const dynamic = "force-dynamic";

/** What the signed-in client sees: released files for their jobs and client-wide, and their own uploads in any state. No storage identifier. */
export async function GET(request: Request) {
  try {
    requirePortalFiles();
    return Response.json({ files: await listPortalFiles(isolatedPool(), await currentPortalUserForData(request)) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return uploadFailure(error) ?? portalCommandFailure(error); }
}

/** A client's upload (portal.file.upload): stored in quarantine, scanned, released or held or refused — then recorded and audited. Form fields: file, jobId, category. */
export async function POST(request: Request) {
  try {
    requirePortalFiles();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { fileName, bytes, fields } = await readUpload(request);
    const jobId = String(fields.get("jobId") ?? "").trim() || null;
    // Not defaulted here: the command refuses a missing or unknown category, so what is stored is what the client chose.
    const category = String(fields.get("category") ?? "").trim() as PortalFileCategory;
    const adapter = configuredStorageAdapter();
    const scanner = configuredScanner();
    const ingest = await ingestFile({ adapter, scanner, organisationId: user.organisationId, clientId: user.clientId, jobId, fileName, bytes });
    const outcome = await recordPortalFileUpload(isolatedPool(), { clientId: user.clientId, ingest, category }, portalCommandContext(request, user));
    await withdrawIfReplayed(adapter, ingest, outcome.replayed);
    return commandSuccess(outcome);
  } catch (error) { return uploadFailure(error) ?? portalCommandFailure(error); }
}
