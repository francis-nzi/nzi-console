import { listOpenReopenRequests, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Data entry D3 (R6): the job's open requests from the client to reopen a reviewed entry — for the CRM, who reopens by editing. */
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    const requests = await withTenantRead(pool, organisationId, (db) => listOpenReopenRequests(db, jobId));
    return Response.json({ requests }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiFailure(error);
  }
}
