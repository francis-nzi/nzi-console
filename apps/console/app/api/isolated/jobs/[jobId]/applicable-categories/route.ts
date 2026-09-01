import { listJobApplicableCategories, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// NZC-046 / UX1a — the CRM completeness view: every taxonomy category for the
// job's included scopes (all 15 Scope 3 when Scope 3 is included).
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json(await withTenantRead(pool, organisationId, (db) => listJobApplicableCategories(db, jobId, "crm")));
  } catch (error) {
    return apiFailure(error);
  }
}
