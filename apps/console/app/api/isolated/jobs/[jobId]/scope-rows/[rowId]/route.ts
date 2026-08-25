import { updateScopeRow } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ jobId: string; rowId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "scope.row.update"); const { jobId, rowId } = await params;
    const body = await request.json() as Omit<CommandInputMap["scope.row.update"], "jobId" | "rowId">;
    return commandSuccess(await updateScopeRow(isolatedPool(), { ...body, jobId, rowId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
