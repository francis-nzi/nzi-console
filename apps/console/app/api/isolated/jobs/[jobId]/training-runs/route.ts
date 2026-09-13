import { listTrainingRunsForJob, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

// The training module's read model — the run, its sessions and register, and every place
// the client holds. Read through the tenant guard like every other screen, so a job from
// another organisation returns nothing rather than someone else's register.
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json({ runs: await withTenantRead(pool, organisationId, (db) => listTrainingRunsForJob(db, jobId)) });
  } catch (error) { return apiFailure(error); }
}
