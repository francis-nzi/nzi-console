import { acceptPortalTerms, PortalTermsError } from "@nzi/isolated-backend";
import { portalAuthFailure } from "../../../../lib/authResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentPortalUser, portalTermsVersionValue, requirePortalOrigin } from "../../../../lib/portalSession";

export const dynamic = "force-dynamic";

// P2b — record a portal user's acceptance of the current terms of access.
// Uses `currentPortalUser` (not the data variant) so a user who still owes
// terms can reach it.
export async function POST(request: Request) {
  try {
    requirePortalOrigin(request);
    const user = await currentPortalUser(request);
    const body = (await request.json().catch(() => ({}))) as { version?: unknown };
    if (typeof body.version !== "string" || body.version.trim() === "") {
      return Response.json({ code: "INVALID_TERMS_VERSION", message: "The terms version is required." }, { status: 422 });
    }
    const result = await acceptPortalTerms(isolatedPool(), user, { version: body.version }, portalTermsVersionValue());
    return Response.json({ accepted: true, acceptedVersion: result.acceptedVersion }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof PortalTermsError) return Response.json({ code: "TERMS_VERSION_STALE", message: error.message }, { status: 409 });
    return portalAuthFailure(error);
  }
}
