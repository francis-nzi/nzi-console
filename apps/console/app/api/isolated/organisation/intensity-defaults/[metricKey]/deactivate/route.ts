import { deactivateIntensityDefault } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a default intensity metric — new clients stop starting with it; nothing already on a client changes. */
export async function POST(request: Request, { params }: { params: Promise<{ metricKey: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "organisation.intensityDefault.deactivate");
    const { metricKey } = await params;
    const body = await request.json() as Omit<CommandInputMap["organisation.intensityDefault.deactivate"], "metricKey">;
    return commandSuccess(await deactivateIntensityDefault(isolatedPool(), { ...body, metricKey: decodeURIComponent(metricKey) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
