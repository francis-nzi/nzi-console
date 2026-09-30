import { readJobMilestones, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** A job's milestones for its page's panel (PR 3): each with its source, lineage and Risk, and what a reschedule would do. */
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json({ view: await withTenantRead(pool, organisationId, (db) => readJobMilestones(db, decodeURIComponent(jobId))) });
  } catch (error) { return apiFailure(error); }
}
