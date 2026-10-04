import { setJobBudget } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** A job's budgeted hours (Time PR B, ⚑5) — job.manage, through the command runner. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.budget.set");
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.budget.set"], "jobId">;
    return commandSuccess(await setJobBudget(isolatedPool(), { ...body, jobId: decodeURIComponent(jobId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
