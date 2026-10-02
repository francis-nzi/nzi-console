import { reinstateBdStage } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a funnel stage (admin F2) — admin.lookups. */
export async function POST(request: Request, { params }: { params: Promise<{ stageId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "bd_stage.reinstate");
    const { stageId } = await params;
    const body = await request.json() as Omit<CommandInputMap["bd_stage.reinstate"], "stageId">;
    return commandSuccess(await reinstateBdStage(isolatedPool(), { ...body, stageId: decodeURIComponent(stageId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
