import { createMasterTemplate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a master template (data-entry R1, 0197) — admin.lookups, through the command runner. It starts with no lines. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "master.template.create");
    const body = await request.json() as CommandInputMap["master.template.create"];
    return commandSuccess(await createMasterTemplate(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
