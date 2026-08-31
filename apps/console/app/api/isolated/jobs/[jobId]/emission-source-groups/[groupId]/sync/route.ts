import { syncEmissionSourceGroupToScope } from "@nzi/isolated-backend";
import { requireCommandPrincipal } from "../../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// S1 — roll the group's enabled members up into one auto-generated canonical row.
export async function POST(request: Request, { params }: { params: Promise<{ jobId: string; groupId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "emission.source.group.sync");
    const { jobId, groupId } = await params;
    return commandSuccess(await syncEmissionSourceGroupToScope(isolatedPool(), { jobId, groupId }, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
