import { getReportVersionSectionPlan, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

// Reporting F-1b — a report version's section plan, its origin and the version publish will pin: what the preparation page
// holds while it reorders. Read only.
export async function GET(request: Request, { params }: { params: Promise<{ versionId: string }> }) {
  try {
    const principal = await currentStaff(request);
    const { versionId } = await params;
    const plan = await withTenantRead(isolatedPool(), principal.organisationId, (db) => getReportVersionSectionPlan(db, versionId));
    if (!plan) return Response.json({ code: "NOT_FOUND", message: "The report version was not found." }, { status: 404 });
    return Response.json({ plan }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
