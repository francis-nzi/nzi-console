import { recalculateClientBaseline, setClientBaseline } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Sets the client's first baseline. A second one is a re-basing — see PATCH. */
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.baseline.set");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.baseline.set"], "clientId">;
    return commandSuccess(await setClientBaseline(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

/** Re-bases: reason required (x-command-reason), prior record retained and superseded. */
export async function PATCH(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.baseline.recalculate");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.baseline.recalculate"], "clientId">;
    return commandSuccess(await recalculateClientBaseline(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
