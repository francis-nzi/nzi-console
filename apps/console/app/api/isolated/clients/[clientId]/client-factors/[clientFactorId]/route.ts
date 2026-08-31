import { archiveClientFactor, updateClientFactor } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// S2 — a versioned edit (PATCH) and archive/un-archive (POST) of one client
// factor. Both map to `datasets.override` via the command registry.
export async function PATCH(request: Request, { params }: { params: Promise<{ clientFactorId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.factor.update");
    const { clientFactorId } = await params;
    const body = (await request.json()) as Omit<CommandInputMap["client.factor.update"], "clientFactorId">;
    return commandSuccess(await updateClientFactor(isolatedPool(), { clientFactorId, ...body }, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ clientFactorId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.factor.archive");
    const { clientFactorId } = await params;
    const body = (await request.json()) as { archived?: boolean };
    return commandSuccess(await archiveClientFactor(isolatedPool(), { clientFactorId, archived: body.archived === true }, commandContext(request, principal)));
  } catch (error) {
    return commandFailure(error);
  }
}
