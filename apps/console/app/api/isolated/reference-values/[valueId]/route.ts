import { updateReferenceValue } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a lookup value's label, code and order (admin A2) — versioned, admin.lookups. */
export async function PATCH(request: Request, { params }: { params: Promise<{ valueId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "reference.value.update");
    const { valueId } = await params;
    const body = await request.json() as Omit<CommandInputMap["reference.value.update"], "valueId">;
    return commandSuccess(await updateReferenceValue(isolatedPool(), { ...body, valueId: decodeURIComponent(valueId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
