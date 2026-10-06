import { updateJobDatasets } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// DATASET-CURRENCY §3 — move the job to its reporting year's editions, as previewed (scoperow.edit). A reason
// (x-command-reason) is required when the job has issued figures.
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.datasets.update");
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.datasets.update"], "jobId">;
    return commandSuccess(await updateJobDatasets(isolatedPool(), { ...body, jobId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
