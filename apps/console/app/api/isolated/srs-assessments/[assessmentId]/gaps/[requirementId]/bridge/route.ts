import { bridgeSrsGap } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// SRS S3, R1: bridge one gap with one action — a library action aligned to it, or one in the consultant's words (which
// may start from an AI idea). It joins the plan as an srs_gap action and, while the assessment is in progress, is linked.
export async function POST(request: Request, { params }: { params: Promise<{ assessmentId: string; requirementId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.gap.bridge");
    const { assessmentId, requirementId } = await params;
    const body = await request.json() as Omit<CommandInputMap["srs.gap.bridge"], "assessmentId" | "requirementId">;
    return commandSuccess(await bridgeSrsGap(isolatedPool(), { ...body, assessmentId, requirementId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
