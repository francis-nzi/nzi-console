import { updateJobType } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a job type (admin C1) — versioned, admin.lookups; the family is locked while jobs use the type (Q4). */
export async function PATCH(request: Request, { params }: { params: Promise<{ jobTypeId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job_type.update");
    const { jobTypeId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job_type.update"], "jobTypeId">;
    return commandSuccess(await updateJobType(isolatedPool(), { ...body, jobTypeId: decodeURIComponent(jobTypeId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
