import { readJobTimeSummary, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** Job → Time: hours by person against the budget — everyone's with time.view on the job, one's own with time.log alone. */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await currentStaff(request);
    const { jobId } = await params;
    const summary = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readJobTimeSummary(db, principal, decodeURIComponent(jobId)));
    return Response.json({ summary }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
