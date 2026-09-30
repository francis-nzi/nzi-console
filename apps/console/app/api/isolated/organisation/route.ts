import { updateOrganisationProfile } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Save the organisation profile, whole, under its version (admin Phase D) — admin.settings. Never the bank details. */
export async function PATCH(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "organisation.profile.update");
    const body = await request.json() as CommandInputMap["organisation.profile.update"];
    return commandSuccess(await updateOrganisationProfile(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
