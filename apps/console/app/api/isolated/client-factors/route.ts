import { createClientFactor, listClientFactors, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// GAPS G3 — organisation-level factors (0240 D-3): no client, offered on every client's jobs. Listed on the Clients page's
// Organisation factors tab, and made there, under `clientfactor.manage`.
export async function GET() {
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    const factors = await withTenantRead(pool, organisationId, (db) => listClientFactors(db, organisationId, null));
    return Response.json({ factors });
  } catch (error) {
    return apiFailure(error);
  }
}

export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "client.factor.create");
    const body = (await request.json()) as Omit<CommandInputMap["client.factor.create"], "jobId" | "clientId" | "organisationLevel">;
    return commandSuccess(await createClientFactor(isolatedPool(), { ...body, jobId: null, clientId: null, organisationLevel: true }, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
