import { previewPortalSpendImport } from "@nzi/isolated-backend";
import { PORTAL_IMPORT_MAX_ROWS, type SpendImportRow } from "@nzi/contracts";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { currentPortalUserForData, requirePortalOrigin } from "../../../../../../lib/portalSession";
import { PortalDataOffError, portalCommandFailure, portalDataOff, requirePortalData } from "../../../../../../lib/portalCommand";

export const dynamic = "force-dynamic";

/**
 * The portal's spend-import preview (RULING-portal-import-spend): the CRM's own line review plus the portal's checks — where each line
 * will be filed (read-only; the staff allocation map decides), what is already here, what matches a carried-forward line. Read-only and a
 * convenience: the commit reviews again inside its transaction. A POST so the portal's same-origin rule holds for it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requirePortalData();
    requirePortalOrigin(request);
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const body = (await request.json().catch(() => ({}))) as { rows?: SpendImportRow[] };
    const lines = Array.isArray(body.rows) ? body.rows.slice(0, PORTAL_IMPORT_MAX_ROWS) : [];
    const preview = await previewPortalSpendImport(isolatedPool(), user, jobId, lines, process.env.NZI_CONSOLE_SESSION_SECRET);
    // In the `{ data }` envelope the panel's `postBrowserCommand` reads as success, as the CRM's preflight does.
    return Response.json({ data: preview }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return error instanceof PortalDataOffError ? portalDataOff() : portalCommandFailure(error); }
}
