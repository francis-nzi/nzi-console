import { reinstateReferenceValue } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a deactivated lookup value (admin A2) — admin.lookups. */
export async function POST(request: Request, { params }: { params: Promise<{ valueId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "reference.value.reinstate");
    const { valueId } = await params;
    const body = await request.json() as Omit<CommandInputMap["reference.value.reinstate"], "valueId">;
    return commandSuccess(await reinstateReferenceValue(isolatedPool(), { ...body, valueId: decodeURIComponent(valueId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
