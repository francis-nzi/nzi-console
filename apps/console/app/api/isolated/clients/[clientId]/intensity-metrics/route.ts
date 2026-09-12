import { deactivateClientIntensityMetric, setClientIntensityMetric } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// Define or redefine one of this client's intensity metrics (client.edit). A change is a
// new version; the one before it stays readable for the reports issued against it.
export async function PUT(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.intensityMetric.set");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.intensityMetric.set"], "clientId">;
    return commandSuccess(await setClientIntensityMetric(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}

// Deactivate, never delete — a historical report still needs the metric it was issued with.
export async function POST(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "client.intensityMetric.deactivate");
    const { clientId } = await params;
    const body = await request.json() as Omit<CommandInputMap["client.intensityMetric.deactivate"], "clientId">;
    return commandSuccess(await deactivateClientIntensityMetric(isolatedPool(), { ...body, clientId }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
