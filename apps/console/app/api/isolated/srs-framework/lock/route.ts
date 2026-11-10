import { lockSrsFramework } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Lock an SRS framework, making its next snapshot (framework rework, Phase B) — admin.lookups; a snapshot is never edited (0187, 0222).
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.framework.lock");
    const body = await request.json() as CommandInputMap["srs.framework.lock"];
    return commandSuccess(await lockSrsFramework(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
