import { assertClientAccess, AuthorizationError, capabilityScope, CommandValidationError, fetchLogoFromUrl, setClientLogo, withTenantRead } from "@nzi/isolated-backend";
import { commandDefinitions } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/**
 * A client logo from a URL (CLIENT-02): the caller's client.logo.set is checked first — the capability, then (for an
 * own-clients holder) that this client is theirs, as the command itself would — so nothing is fetched for someone who
 * could not set it; then the address is fetched once, hardened (`fetchLogoFromUrl`), and stored through client.logo.set
 * exactly as an upload is — the URL itself is not kept.
 */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.logo.set");
    const { clientId } = await params;
    const capability = commandDefinitions["client.logo.set"].permission;
    const access = await withTenantRead(isolatedPool(), principal.organisationId, (db) => assertClientAccess(db, principal.organisationId, principal.userId, clientId));
    if (capabilityScope(principal, capability) === "own_clients" && !access.ownedByActor) throw new AuthorizationError(capability, "This capability is limited to your own clients.");
    const body = await request.json().catch(() => null) as { url?: unknown } | null;
    if (typeof body?.url !== "string" || !body.url.trim()) throw new CommandValidationError([{ field: "url", code: "REQUIRED", message: "Enter the logo's web address." }]);
    const fetched = await fetchLogoFromUrl(body.url);
    if (!fetched.ok) throw new CommandValidationError([{ field: "url", code: fetched.code, message: fetched.message }]);
    return commandSuccess(await setClientLogo(isolatedPool(), { clientId, fileName: fetched.fileName, contentType: fetched.contentType, dataBase64: fetched.dataBase64 }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
