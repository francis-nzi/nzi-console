import { listJobApplicableCategories, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// NZC-046 / UX1a — the CRM completeness view: every taxonomy category for the
// job's included scopes (all 15 Scope 3 when Scope 3 is included). `?siteId=` narrows the
// per-category figures to the site tab in force ("all" is the tab, not a site: unnarrowed).
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    const siteId = new URL(request.url).searchParams.get("siteId")?.trim() || null;
    return Response.json(await withTenantRead(pool, organisationId, (db) => listJobApplicableCategories(db, jobId, "crm", siteId === "all" ? null : siteId)));
  } catch (error) {
    return apiFailure(error);
  }
}
