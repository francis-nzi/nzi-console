import { unlockSrsFramework } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Unlock an SRS framework for editing (framework rework, Phase B) — admin.lookups; stamped in the history (0222).
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.framework.unlock");
    const body = await request.json() as CommandInputMap["srs.framework.unlock"];
    return commandSuccess(await unlockSrsFramework(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
