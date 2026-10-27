import { reallocateScopeRow } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Data entry D2 (R4): move a spend line to the category it belongs in, at review — which also teaches the client's map. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string; rowId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "scope.row.reallocate");
    const { jobId, rowId } = await params;
    const body = await request.json() as Omit<CommandInputMap["scope.row.reallocate"], "jobId" | "rowId">;
    return commandSuccess(await reallocateScopeRow(isolatedPool(), { ...body, jobId, rowId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
