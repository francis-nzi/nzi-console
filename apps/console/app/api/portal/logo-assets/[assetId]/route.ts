import { getLogoAsset, logoResponse, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../../lib/authResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../../lib/portalSession";

export const dynamic = "force-dynamic";

// A published report's frozen logo, restricted to the portal user's own client.
export async function GET(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const user = await currentPortalUserForData(request);
    const { assetId } = await params;
    return logoResponse(await withTenantRead(isolatedPool(), user.organisationId, (db) => getLogoAsset(db, assetId, { clientId: user.clientId })), request.headers.get("if-none-match"));
  } catch (error) { return portalAuthFailure(error); }
}
