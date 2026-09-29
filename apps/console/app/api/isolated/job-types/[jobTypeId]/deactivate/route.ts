import { deactivateJobType } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a job type (admin C1) — never deleted; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ jobTypeId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job_type.deactivate");
    const { jobTypeId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job_type.deactivate"], "jobTypeId">;
    return commandSuccess(await deactivateJobType(isolatedPool(), { ...body, jobTypeId: decodeURIComponent(jobTypeId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
