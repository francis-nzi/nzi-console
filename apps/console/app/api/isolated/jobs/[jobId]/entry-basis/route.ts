import { readJobEntryBasis, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Data entry D1 (R4): what this job's add-entry drawers open on — the organisation's default basis per category, the client's
// last choice per category, and the client's currency for a fresh spend entry. Read-only; the drawer chooses from it.
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    const basis = await withTenantRead(pool, organisationId, (db) => readJobEntryBasis(db, organisationId, jobId));
    return Response.json(basis, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiFailure(error);
  }
}
