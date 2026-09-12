import { completeSrsAssessment, setSrsAssessmentItem } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Answer one requirement on a draft assessment (srs.manage).
export async function PUT(request: Request, { params }: { params: Promise<{ assessmentId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.assessment.item.set");
    const { assessmentId } = await params;
    const body = await request.json() as Omit<CommandInputMap["srs.assessment.item.set"], "assessmentId">;
    return commandSuccess(await setSrsAssessmentItem(isolatedPool(), { ...body, assessmentId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

// Close the assessment; the next reassessment starts a new one, which is the trend.
export async function POST(request: Request, { params }: { params: Promise<{ assessmentId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.assessment.complete");
    const { assessmentId } = await params;
    const body = await request.json() as Omit<CommandInputMap["srs.assessment.complete"], "assessmentId">;
    return commandSuccess(await completeSrsAssessment(isolatedPool(), { ...body, assessmentId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
