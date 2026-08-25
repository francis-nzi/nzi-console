import { createScopeRow, listScopeRows, withTenantRead } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { apiFailure, isolatedPool, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const { jobId } = await params; const { pool, organisationId } = requireIsolatedApiContext();
    return Response.json({ rows: await withTenantRead(pool, organisationId, (db) => listScopeRows(db, jobId)) });
  } catch (error) { return apiFailure(error); }
}

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "scope.row.create"); const { jobId } = await params;
    const body = await request.json() as Omit<CommandInputMap["scope.row.create"], "jobId">;
    return commandSuccess(await createScopeRow(isolatedPool(), { ...body, jobId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
