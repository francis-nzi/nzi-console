import { deactivateReferenceValue } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a lookup value (admin A2) — never deleted; the reason comes in `x-command-reason` and is required (P7). */
export async function POST(request: Request, { params }: { params: Promise<{ valueId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "reference.value.deactivate");
    const { valueId } = await params;
    const body = await request.json() as Omit<CommandInputMap["reference.value.deactivate"], "valueId">;
    return commandSuccess(await deactivateReferenceValue(isolatedPool(), { ...body, valueId: decodeURIComponent(valueId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
