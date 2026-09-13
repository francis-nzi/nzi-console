import { deactivateActionLever, upsertActionLever } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// The catalogue itself (admin.lookups). Deliberately NOT actions.manage: a consultant
// assembles a plan from the library but does not get to redefine the library while doing it.
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "action.lever.upsert");
    const body = await request.json() as CommandInputMap["action.lever.upsert"];
    return commandSuccess(await upsertActionLever(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

// Withdrawing a lever deactivates it — the plans already holding it keep it.
export async function PUT(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "action.lever.deactivate");
    const body = await request.json() as CommandInputMap["action.lever.deactivate"];
    return commandSuccess(await deactivateActionLever(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
