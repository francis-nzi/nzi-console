import { decodeStudioPlan, decodeStudioScope } from "@nzi/contracts";
import { draftReportComposition, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * B2-2 (REVIEW-B2-1-and-B2-rulings, Q6 approved with B0's guardrails): the Report Studio's draft of a job's report — what
 * `report.validate` would hold for its latest approved snapshot with the plan and scope asked for (`?plan=`, `?scope=`), composed
 * now in a READ ONLY transaction and stored nowhere, with anything validate would refuse beside it. GET only; null when the job
 * has no approved snapshot.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const search = new URL(request.url).searchParams;
    const { pool, organisationId } = requireIsolatedApiContext();
    const draft = await withTenantRead(pool, organisationId, (db) => draftReportComposition(db, {
      organisationId, jobId, sectionPlan: decodeStudioPlan(search.get("plan")), scope: decodeStudioScope(search.get("scope")),
    }));
    return Response.json({ draft }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
