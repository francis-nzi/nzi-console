import { logoResponse, readOrganisationLogo, readOrganisationLogoAsset, setOrganisationLogo, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { authFailure } from "../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * The organisation's logo, for any signed-in member of staff — served so it can never act as a document (nosniff, sandbox).
 * `?asset=<id>` serves that asset instead of the current one: the logo a report version froze when it was validated.
 */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    const assetId = new URL(request.url).searchParams.get("asset");
    const asset = await withTenantRead(isolatedPool(), principal.organisationId, (db) => assetId
      ? readOrganisationLogoAsset(db, principal.organisationId, assetId)
      : readOrganisationLogo(db, principal.organisationId));
    return logoResponse(asset, request.headers.get("if-none-match"));
  } catch (error) { return authFailure(error); }
}

/** Upload the organisation's logo (admin Phase D) — admin.settings; the client-logo inspector's rules. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "organisation.logo.set");
    const body = await request.json() as CommandInputMap["organisation.logo.set"];
    return commandSuccess(await setOrganisationLogo(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
