import { setClientTargets } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// NZC-072 — the forward targets (target.edit). The benchmark is not accepted from the
// client: it is read from the baseline in force and stamped onto the version.
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.targets.set");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.targets.set"], "clientId">;
    return commandSuccess(await setClientTargets(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
