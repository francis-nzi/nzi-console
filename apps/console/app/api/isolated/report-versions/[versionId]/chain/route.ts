import { listReportVersionChain, requireCapability, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * The chain of report versions for this version's job and scope, oldest round first (client-review loop S7): revision, status and the
 * lifecycle times, and which earlier versions the CRM could restore wording from. Staff only (`report.view`); GET only - nothing here writes.
 */
export async function GET(request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  try {
    const principal = await currentStaff(request);
    requireCapability(principal, "report.view");
    const { versionId } = await params;
    const chain = await withTenantRead(isolatedPool(), principal.organisationId, (db) => listReportVersionChain(db, versionId));
    return Response.json({ chain }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
