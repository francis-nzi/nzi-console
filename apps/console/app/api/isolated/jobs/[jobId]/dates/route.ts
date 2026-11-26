import { resolveJobDate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * Addendum B.2 — a date that differs from the previous system: "Use V7's dates" or "Keep the console's" (job.dates.resolve).
 * Using V7's reporting period over recorded data is a period move, so it needs the reason (x-command-reason), as an edit would.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "job.dates.resolve");
    const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["job.dates.resolve"], "jobId">;
    return commandSuccess(await resolveJobDate(isolatedPool(), {
      jobId: decodeURIComponent(jobId), expectedVersion: body.expectedVersion, dateKey: body.dateKey, observationNo: body.observationNo, choice: body.choice,
    }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
