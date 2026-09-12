import { startSrsAssessment } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Open a dated SRS readiness assessment (srs.manage). The framework version in force is
// stamped onto it by the handler, never accepted from the caller.
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.assessment.start");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["srs.assessment.start"], "clientId">;
    return commandSuccess(await startSrsAssessment(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
