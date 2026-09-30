import { completeMilestone } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Complete a milestone (PR 3) — today, or a past day (M5); idempotent: an already-completed milestone is returned unchanged. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string; kind: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.milestone.complete");
    const { jobId, kind } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.milestone.complete"], "jobId" | "kind">;
    return commandSuccess(await completeMilestone(isolatedPool(), { ...body, jobId: decodeURIComponent(jobId), kind: decodeURIComponent(kind) as CommandInputMap["job.milestone.complete"]["kind"] }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
