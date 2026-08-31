import { listClientFactors, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// S2 — the client-scoped list of client factors (reusable + the current job's
// pinned ones when `?jobId=` is given), each with a usage count.
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const { clientId } = await params;
    const jobId = new URL(request.url).searchParams.get("jobId");
    const { pool, organisationId } = requireIsolatedApiContext();
    const factors = await withTenantRead(pool, organisationId, (db) => listClientFactors(db, organisationId, clientId, { jobId }));
    return Response.json({ factors });
  } catch (error) {
    return apiFailure(error);
  }
}
