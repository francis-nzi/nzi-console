import { setClientReportProfile } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Reporting F-1 (0164, R-D1) — set the client's report profile (client.edit): a section order and an optional issuer line,
// as the next version.
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.reportProfile.set");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.reportProfile.set"], "clientId">;
    return commandSuccess(await setClientReportProfile(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
