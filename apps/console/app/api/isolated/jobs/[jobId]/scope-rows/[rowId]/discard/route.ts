import { discardScopeRow } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Discard a draft that holds no saved data (JW-14) — a true delete; the write refuses anything with data. */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string; rowId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "scope.row.discard");
    const { jobId, rowId } = await params;
    const body = await request.json() as Omit<CommandInputMap["scope.row.discard"], "jobId" | "rowId">;
    return commandSuccess(await discardScopeRow(isolatedPool(), { ...body, jobId, rowId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
