import { getJobAnnualMetrics, setJobIntensityValue, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// The annual values recorded on this job for a reporting year.
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const year = Number(new URL(request.url).searchParams.get("year"));
    if (!Number.isInteger(year)) return Response.json({ code: "INVALID_YEAR", message: "A reporting year is required." }, { status: 422 });
    const { pool, organisationId } = requireIsolatedApiContext();
    const annual = await withTenantRead(pool, organisationId, (db) => getJobAnnualMetrics(db, jobId, year));
    if (!annual) return Response.json({ code: "NOT_FOUND", message: "That job does not exist." }, { status: 404 });
    return Response.json(annual, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}

// Record one metric's value for one reporting year (scoperow.edit — it is job data entry).
export async function PUT(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.intensityValue.set");
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.intensityValue.set"], "jobId">;
    return commandSuccess(await setJobIntensityValue(isolatedPool(), { ...body, jobId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
