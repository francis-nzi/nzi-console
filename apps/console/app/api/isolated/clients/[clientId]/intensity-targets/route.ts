import { deactivateClientIntensityTarget, setClientIntensityTarget } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Phase 1b (0158) — set one metric's intensity target (target.edit), as the next version. Moving a held baseline needs a
// reason, in x-command-reason.
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.intensityTarget.set");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.intensityTarget.set"], "clientId">;
    return commandSuccess(await setClientIntensityTarget(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

// Withdraw one metric's target — a version that says so; the reason (x-command-reason) is required. Never a delete.
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.intensityTarget.deactivate");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.intensityTarget.deactivate"], "clientId">;
    return commandSuccess(await deactivateClientIntensityTarget(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
