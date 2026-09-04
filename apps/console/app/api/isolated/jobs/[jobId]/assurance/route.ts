import { getAssuranceScreen, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// DA1 (NZC-059) — the Data Assurance screen for a CRP job's Review & QA stage:
// the multi-year emissions trend + the four-flag integrity gap engine result +
// the resolved-with-reason gaps. Read-only; resolutions go through
// assurance.gap.resolve.
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    const screen = await withTenantRead(pool, organisationId, (db) => getAssuranceScreen(db, jobId));
    if (!screen) return Response.json({ code: "NOT_FOUND", message: "Data assurance is available only for CRP jobs." }, { status: 404 });
    return Response.json(screen, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiFailure(error);
  }
}
