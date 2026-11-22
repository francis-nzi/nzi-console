import { readV7ImportBatch, requireCapability, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../lib/authResponse";
import { importBatchDeps } from "../../../../../lib/importBatchDeps";
import { handleImportBatch } from "../../../../../lib/importBatchHandler";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** The client's latest batch, its tally and its review queue (BRIEF-v7-import-server-side-phase-e) — `import.refresh_batch` to read at all. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const { clientId } = await params;
    const principal = await currentStaff(request);
    requireCapability(principal, "import.refresh_batch");
    const view = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readV7ImportBatch(db, principal.organisationId, clientId));
    return Response.json({ ...view, writeEnabled: process.env.NZI_WRITE_API_ENABLED === "true" }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}

/** "Refresh all from the previous system": start a batch over the client's imported jobs — `import.refresh_batch` (Admin). */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  const { clientId } = await params;
  return handleImportBatch(request, clientId, "start", importBatchDeps);
}
