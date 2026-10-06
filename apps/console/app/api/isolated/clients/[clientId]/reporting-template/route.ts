import { setClientReportingTemplate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Phase 1c (0159) — set the client's whole reporting template (client.edit), as the next version.
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.reportingTemplate.set");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.reportingTemplate.set"], "clientId">;
    return commandSuccess(await setClientReportingTemplate(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
