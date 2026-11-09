import { setSrsReviewSchedule } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Set when the latest completed assessment is next reviewed — a cadence, a date, or off (srs.manage). A new date re-arms the reminder.
export async function PUT(request: Request, { params }: { params: Promise<{ assessmentId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.assessment.review.set");
    const { assessmentId } = await params;
    const body = await request.json() as Omit<CommandInputMap["srs.assessment.review.set"], "assessmentId">;
    return commandSuccess(await setSrsReviewSchedule(isolatedPool(), { ...body, assessmentId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
