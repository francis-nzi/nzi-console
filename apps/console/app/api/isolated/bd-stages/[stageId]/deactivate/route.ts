import { deactivateBdStage } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a funnel stage (admin F2) — never deleted, never the last active one; the reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ stageId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "bd_stage.deactivate");
    const { stageId } = await params;
    const body = await request.json() as Omit<CommandInputMap["bd_stage.deactivate"], "stageId">;
    return commandSuccess(await deactivateBdStage(isolatedPool(), { ...body, stageId: decodeURIComponent(stageId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
