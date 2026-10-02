import { reinstateCustomField } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a custom field (admin F3) — admin.settings. */
export async function POST(request: Request, { params }: { params: Promise<{ definitionId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "custom_field.reinstate");
    const { definitionId } = await params;
    const body = await request.json() as Omit<CommandInputMap["custom_field.reinstate"], "definitionId">;
    return commandSuccess(await reinstateCustomField(isolatedPool(), { ...body, definitionId: decodeURIComponent(definitionId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
