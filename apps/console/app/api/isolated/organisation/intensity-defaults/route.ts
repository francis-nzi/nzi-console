import { setIntensityDefault } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Define or redefine a default intensity metric (a new version) — admin.settings. New clients start with the active ones. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "organisation.intensityDefault.set");
    const body = await request.json() as CommandInputMap["organisation.intensityDefault.set"];
    return commandSuccess(await setIntensityDefault(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
