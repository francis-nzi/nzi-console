import { createBdStage } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a funnel stage (admin F2) — admin.lookups; its key is set here and never again. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "bd_stage.create");
    const body = await request.json() as CommandInputMap["bd_stage.create"];
    return commandSuccess(await createBdStage(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
