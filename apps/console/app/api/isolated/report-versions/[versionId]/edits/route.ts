import { listReportVersionEdits, requireCapability, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * A report version's edit history (client-review loop S3, 0217): who changed which section, from what to what, and when - oldest first.
 * Staff only (`report.view`): the before and after wording is the working draft, not the client's view. GET only; nothing here writes.
 */
export async function GET(request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  try {
    const principal = await currentStaff(request);
    requireCapability(principal, "report.view");
    const { versionId } = await params;
    const edits = await withTenantRead(isolatedPool(), principal.organisationId, (db) => listReportVersionEdits(db, versionId));
    return Response.json({ edits }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
