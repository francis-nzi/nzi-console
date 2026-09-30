import { removeOrganisationLogo } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Remove the organisation's logo — the pointer is cleared; the asset is kept for the audit trail. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "organisation.logo.remove");
    return commandSuccess(await removeOrganisationLogo(isolatedPool(), {}, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
