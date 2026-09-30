import { rescheduleMilestones } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reschedule a job's milestones from its template, or a new one (PR 3; M1) — only uncompleted template rows move; also applies a template to a job with none (Q7). */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.milestone.reschedule");
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.milestone.reschedule"], "jobId">;
    return commandSuccess(await rescheduleMilestones(isolatedPool(), { ...body, jobId: decodeURIComponent(jobId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
