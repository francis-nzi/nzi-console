import { reinstateJobType } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a job type (admin C1) — back into the pickers; its name is still its own (Q2). */
export async function POST(request: Request, { params }: { params: Promise<{ jobTypeId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job_type.reinstate");
    const { jobTypeId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job_type.reinstate"], "jobTypeId">;
    return commandSuccess(await reinstateJobType(isolatedPool(), { ...body, jobTypeId: decodeURIComponent(jobTypeId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
