import { getClientLogo, logoResponse, setClientLogo, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** The client's current logo (404 → the monogram is shown). Staging storage only. */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const { clientId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    return logoResponse(await withTenantRead(pool, organisationId, (db) => getClientLogo(db, clientId)), request.headers.get("if-none-match"));
  } catch (error) { return apiFailure(error); }
}

export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.logo.set");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.logo.set"], "clientId">;
    return commandSuccess(await setClientLogo(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
