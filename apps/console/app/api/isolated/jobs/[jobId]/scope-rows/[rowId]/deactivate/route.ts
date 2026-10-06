import { deactivateScopeRow } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a console row with data (JW-14) — kept, figures and all; the reason comes in x-command-reason and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string; rowId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "scope.row.deactivate");
    const { jobId, rowId } = await params;
    const body = await request.json() as Omit<CommandInputMap["scope.row.deactivate"], "jobId" | "rowId">;
    return commandSuccess(await deactivateScopeRow(isolatedPool(), { ...body, jobId, rowId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
