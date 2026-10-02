import { createCustomField } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a custom field definition (admin F3) — admin.settings; its entity, key and type are set here and never again. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "custom_field.create");
    const body = await request.json() as CommandInputMap["custom_field.create"];
    return commandSuccess(await createCustomField(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
