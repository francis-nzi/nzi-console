import { updateSrsMaturityLevel } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Reword a ladder step in the draft (SRS S1, R1) — admin.lookups; a published version is never edited (0187).
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "srs.framework.maturity.update");
    const body = await request.json() as CommandInputMap["srs.framework.maturity.update"];
    return commandSuccess(await updateSrsMaturityLevel(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
