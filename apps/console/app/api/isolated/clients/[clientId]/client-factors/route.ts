import { createClientFactor, listClientFactors, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// S2 — the client-scoped list of client factors (reusable + the current job's
// pinned ones when `?jobId=` is given), each with a usage count.
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const { clientId } = await params;
    const jobId = new URL(request.url).searchParams.get("jobId");
    const { pool, organisationId } = requireIsolatedApiContext();
    const factors = await withTenantRead(pool, organisationId, (db) => listClientFactors(db, organisationId, clientId, { jobId }));
    return Response.json({ factors });
  } catch (error) {
    return apiFailure(error);
  }
}

// GAPS G6 — a factor made on the client page: the client's, reusable across its jobs.
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.factor.create");
    const { clientId } = await params;
    const body = (await request.json()) as Omit<CommandInputMap["client.factor.create"], "jobId" | "clientId" | "organisationLevel">;
    return commandSuccess(await createClientFactor(isolatedPool(), { ...body, jobId: null, clientId, organisationLevel: false }, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
