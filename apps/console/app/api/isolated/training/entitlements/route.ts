import { setTrainingEntitlementExpiry } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Move a grant's expiry (training.entitlement.manage). Extending something already granted
// is an operational concession, so it sits with the delivering team — and, like a
// re-baseline, it needs a reason, is audited, and stops being "the default". The grant
// moves as a unit, so its places can never quote two different dates.
export async function PUT(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "training.entitlement.expiry.set");
    const body = await request.json() as CommandInputMap["training.entitlement.expiry.set"];
    return commandSuccess(await setTrainingEntitlementExpiry(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
