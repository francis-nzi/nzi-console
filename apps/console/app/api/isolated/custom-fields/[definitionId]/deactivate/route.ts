import { deactivateCustomField } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a custom field (admin F3) — never deleted; values held for it are kept. The reason comes in `x-command-reason` and is required. */
export async function POST(request: Request, { params }: { params: Promise<{ definitionId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "custom_field.deactivate");
    const { definitionId } = await params;
    const body = await request.json() as Omit<CommandInputMap["custom_field.deactivate"], "definitionId">;
    return commandSuccess(await deactivateCustomField(isolatedPool(), { ...body, definitionId: decodeURIComponent(definitionId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
