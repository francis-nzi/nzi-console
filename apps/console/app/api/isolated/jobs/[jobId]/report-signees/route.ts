import { listJobReportSignees, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// The signee picker: only the job's client's active report-signee contacts.
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json({ signees: await withTenantRead(pool, organisationId, (db) => listJobReportSignees(db, jobId)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
