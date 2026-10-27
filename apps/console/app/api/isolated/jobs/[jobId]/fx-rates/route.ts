import { readJobCurrencies, setJobSiteFxRate, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Data entry D3 (R1): the job's currencies — the client's, each site's, and the FX rate the job holds per site (the CRM's average for
// the reporting period). Read for the job's Currency & FX panel; a rate is used only to express money in the client's currency.
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json(await withTenantRead(pool, organisationId, (db) => readJobCurrencies(db, organisationId, jobId)), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}

/** Set one site's rate for the job (scoperow.edit, versioned, audited). Never read by the emissions calculation. */
export async function PUT(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.site.fx.set");
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.site.fx.set"], "jobId">;
    return commandSuccess(await setJobSiteFxRate(isolatedPool(), { ...body, jobId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
