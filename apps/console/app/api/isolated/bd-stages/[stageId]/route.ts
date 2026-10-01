import { updateBdStage } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a funnel stage's name, order and probability (admin F2) — admin.lookups, against its version. */
export async function PATCH(request: Request, { params }: { params: Promise<{ stageId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "bd_stage.update");
    const { stageId } = await params;
    const body = await request.json() as Omit<CommandInputMap["bd_stage.update"], "stageId">;
    return commandSuccess(await updateBdStage(isolatedPool(), { ...body, stageId: decodeURIComponent(stageId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
