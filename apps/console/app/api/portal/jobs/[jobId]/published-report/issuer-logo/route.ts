import { getGrantedIssuerLogo, logoResponse, withTenantRead } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";
import { currentPortalUserForData } from "../../../../../../lib/portalSession";

export const dynamic = "force-dynamic";

/**
 * Reporting F-4a (D4): the issuer's logo as a published report of this job froze it (`?asset=`), for the composed report's
 * cover. Only an issuer logo of a report this user holds a grant to — never another organisation asset. Served so it can
 * never act as a document (nosniff, sandbox), as every logo is.
 */
export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const user = await currentPortalUserForData(request);
    const { jobId } = await params;
    const assetId = new URL(request.url).searchParams.get("asset") ?? "";
    const asset = assetId ? await withTenantRead(isolatedPool(), user.organisationId, (db) =>
      getGrantedIssuerLogo(db, { organisationId: user.organisationId, portalUserId: user.userId, clientId: user.clientId, jobId, assetId })) : null;
    return logoResponse(asset, request.headers.get("if-none-match"));
  } catch (error) { return portalAuthFailure(error); }
}
