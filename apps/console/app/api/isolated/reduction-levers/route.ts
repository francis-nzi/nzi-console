import { deactivateLever, upsertLever } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// The levers the library is allocated to (Actions A1, R1) — reference data, admin.lookups, as the library is.
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "strategy.lever.upsert");
    const body = await request.json() as CommandInputMap["strategy.lever.upsert"];
    return commandSuccess(await upsertLever(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

// Withdrawing a lever deactivates it — the strategies under it keep their allocation.
export async function PUT(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "strategy.lever.deactivate");
    const body = await request.json() as CommandInputMap["strategy.lever.deactivate"];
    return commandSuccess(await deactivateLever(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
