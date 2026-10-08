import { getJobTemplateSeeding, seedJobFromTemplate, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Phase 3b: the client's reporting template in force, and which version last seeded this job. */
export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params, { pool, organisationId } = requireIsolatedApiContext();
    return Response.json({ seeding: await withTenantRead(pool, organisationId, (db) => getJobTemplateSeeding(db, decodeURIComponent(jobId))) });
  } catch (error) { return apiFailure(error); }
}

/** Seed (or re-seed, filling gaps) the job's entry rows from the template version the person was shown. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.seedFromTemplate");
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.seedFromTemplate"], "jobId">;
    return commandSuccess(await seedJobFromTemplate(isolatedPool(), { jobId: decodeURIComponent(jobId), expectedTemplateVersion: body.expectedTemplateVersion }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
