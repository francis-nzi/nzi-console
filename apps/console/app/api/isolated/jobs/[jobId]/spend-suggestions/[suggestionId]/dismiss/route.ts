import { dismissSpendAllocationSuggestion } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Data entry D2 (R5): a person dismisses an AI suggestion — nothing is written to the map (scoperow.edit, audited). */
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string; suggestionId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "spend_allocation.suggestion.dismiss");
    const { jobId, suggestionId } = await params;
    const body = await request.json() as Omit<CommandInputMap["spend_allocation.suggestion.dismiss"], "jobId" | "suggestionId">;
    return commandSuccess(await dismissSpendAllocationSuggestion(isolatedPool(), { ...body, jobId, suggestionId } as CommandInputMap["spend_allocation.suggestion.dismiss"], commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
