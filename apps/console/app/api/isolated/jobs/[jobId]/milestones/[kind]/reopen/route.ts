import { reopenMilestone } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reopen a completed milestone (PR 3) — the reason comes in `x-command-reason` and is required (Q12). */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string; kind: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.milestone.reopen");
    const { jobId, kind } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.milestone.reopen"], "jobId" | "kind">;
    return commandSuccess(await reopenMilestone(isolatedPool(), { ...body, jobId: decodeURIComponent(jobId), kind: decodeURIComponent(kind) as CommandInputMap["job.milestone.reopen"]["kind"] }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
