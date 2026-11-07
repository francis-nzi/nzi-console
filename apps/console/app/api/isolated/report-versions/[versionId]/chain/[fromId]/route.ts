import { previewPriorVersion, requireCapability, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * A prior version's document, to look at before restoring its wording (client-review loop S7): read back frozen if it was issued, else composed
 * now from its own snapshot, plan and narrative and stored nowhere. Only a version in the same job and scope is reachable; anything else is 404.
 * Staff only (`report.view`); GET only, inside a read-only transaction.
 */
export async function GET(request: Request, { params }: { params: Promise<{ versionId: string; fromId: string }> }) {
  try {
    const principal = await currentStaff(request);
    requireCapability(principal, "report.view");
    const { versionId, fromId } = await params;
    const preview = await withTenantRead(isolatedPool(), principal.organisationId, (db) => previewPriorVersion(db, { organisationId: principal.organisationId, reportVersionId: versionId, fromReportVersionId: fromId }));
    if (!preview) return Response.json({ code: "NOT_FOUND", message: "That version is not part of this report's history." }, { status: 404 });
    return Response.json(preview, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
