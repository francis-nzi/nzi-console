import { deactivateClientReportProfile } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Reporting F-1 (0164, R-D1) — withdraw the client's report profile: a version that says so; the reason (x-command-reason)
// is required. Never a delete.
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.reportProfile.deactivate");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.reportProfile.deactivate"], "clientId">;
    return commandSuccess(await deactivateClientReportProfile(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
