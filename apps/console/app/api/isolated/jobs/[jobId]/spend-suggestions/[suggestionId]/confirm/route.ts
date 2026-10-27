import { confirmSpendAllocationSuggestion } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Data entry D2 (R5): a person confirms an AI suggestion — which writes the client's map (scoperow.edit, audited). */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string; suggestionId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "spend_allocation.suggestion.confirm");
    const { jobId, suggestionId } = await params;
    const body = await request.json() as Omit<CommandInputMap["spend_allocation.suggestion.confirm"], "jobId" | "suggestionId">;
    return commandSuccess(await confirmSpendAllocationSuggestion(isolatedPool(), { ...body, jobId, suggestionId } as CommandInputMap["spend_allocation.suggestion.confirm"], commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
