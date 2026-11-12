import { setV7ImportDecision } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Import workbench, Phase 2: resolve one row of a job's latest import summary — import.manage, audited by the job. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "import.decision.set");
    const body = await request.json() as CommandInputMap["import.decision.set"];
    return commandSuccess(await setV7ImportDecision(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
