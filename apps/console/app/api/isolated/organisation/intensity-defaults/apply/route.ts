import { applyIntensityDefaults } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Q5: the defaults onto every client with no intensity metric, for the count confirmed — admin.settings, a reason required. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "organisation.intensityDefaults.apply");
    const body = await request.json() as CommandInputMap["organisation.intensityDefaults.apply"];
    return commandSuccess(await applyIntensityDefaults(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
