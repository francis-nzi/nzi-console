import { clearV7ImportDecision } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Import workbench, Phase 2: return a row to unresolved — its decision is superseded and kept. import.manage, audited by the job. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "import.decision.clear");
    const body = await request.json() as CommandInputMap["import.decision.clear"];
    return commandSuccess(await clearV7ImportDecision(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
