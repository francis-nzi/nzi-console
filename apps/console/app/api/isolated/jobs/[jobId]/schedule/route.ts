import { planJobUpdate, previewJobUpdate, updateJob, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

type Change = Omit<CommandInputMap["job.update"], "jobId" | "expectedVersion">;

/**
 * What a schedule change would do (job.update, ruled J1–J6): the same plan the command applies — the milestones, the
 * reporting year, the window and its datasets, and any refusal. A parameter left out is unchanged; an empty one clears.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    const query = new URL(request.url).searchParams;
    const change: Change = {};
    if (query.has("startDate")) change.startDate = query.get("startDate")!;
    for (const field of ["reportingPeriodStart", "reportingPeriodEnd", "milestoneTemplateId"] as const) {
      if (query.has(field)) change[field] = query.get(field) || null;
    }
    const id = decodeURIComponent(jobId);
    // Addendum B.3: a period move over recorded data is previewed by the command itself, run and rolled back — the totals per
    // scope before and after the re-pricing, and any refusal it would meet (a row that cannot be re-priced, say).
    if (change.reportingPeriodStart !== undefined || change.reportingPeriodEnd !== undefined) {
      const principal = await requireCommandPrincipal(request, "job.update");
      const preview = await previewJobUpdate(isolatedPool(), { ...change, jobId: id }, { ...commandContext(request, principal), idempotencyKey: `preview-${crypto.randomUUID()}` });
      return Response.json({ plan: preview?.plan ? { ...preview.plan, issues: preview.refusal } : null, outcome: preview?.outcome ?? null });
    }
    const planned = await withTenantRead(pool, organisationId, (db) => planJobUpdate(db, organisationId, { ...change, jobId: id }, { lock: false }));
    return Response.json({ plan: planned?.plan ?? null, outcome: null });
  } catch (error) { return apiFailure(error); }
}

/** Edit a job's start date, reporting period and milestone template (job.update). A period change needs a reason. */
export async function PATCH(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.update");
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.update"], "jobId">;
    return commandSuccess(await updateJob(isolatedPool(), { ...body, jobId: decodeURIComponent(jobId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
