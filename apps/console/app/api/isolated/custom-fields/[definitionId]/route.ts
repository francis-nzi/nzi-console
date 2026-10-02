import { updateCustomField } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a custom field definition (admin F3) — admin.settings, against its version; options are never removed. */
export async function PATCH(request: Request, { params }: { params: Promise<{ definitionId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "custom_field.update");
    const { definitionId } = await params;
    const body = await request.json() as Omit<CommandInputMap["custom_field.update"], "definitionId">;
    return commandSuccess(await updateCustomField(isolatedPool(), { ...body, definitionId: decodeURIComponent(definitionId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
