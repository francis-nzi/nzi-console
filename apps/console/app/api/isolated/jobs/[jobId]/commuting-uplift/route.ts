import { readJobCommutingUplift, setJobSiteHeadcount, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Employee commuting (3.7) uplift: the job's sites with their headcount, respondents, response rate, uplift factor and the figures
// it yields. The uplift is derived; only the headcount and the choice are written, and the stored scope rows are never touched.
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json(await withTenantRead(pool, organisationId, (db) => readJobCommutingUplift(db, organisationId, jobId)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}

/** Set one site's headcount and uplift choice for the job (scoperow.edit, versioned, audited). */
export async function PUT(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.site.headcount.set");
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.site.headcount.set"], "jobId">;
    return commandSuccess(await setJobSiteHeadcount(isolatedPool(), { ...body, jobId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
