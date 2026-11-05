import { setSrsAssessmentNotes } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Replace the assessment's context note while it is in progress (srs.manage).
export async function PUT(request: Request, { params }: { params: Promise<{ assessmentId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.assessment.notes.set");
    const { assessmentId } = await params;
    const body = await request.json() as Omit<CommandInputMap["srs.assessment.notes.set"], "assessmentId">;
    return commandSuccess(await setSrsAssessmentNotes(isolatedPool(), { ...body, assessmentId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
