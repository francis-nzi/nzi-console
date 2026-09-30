import { setMilestone } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Set or clear one milestone's due date by hand (PR 3) — it becomes manual and is never moved by a reschedule; refused on a completed milestone. */
export async function PATCH(request: Request, { params }: { params: Promise<{ jobId: string; kind: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.milestone.set");
    const { jobId, kind } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.milestone.set"], "jobId" | "kind">;
    return commandSuccess(await setMilestone(isolatedPool(), { ...body, jobId: decodeURIComponent(jobId), kind: decodeURIComponent(kind) as CommandInputMap["job.milestone.set"]["kind"] }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
