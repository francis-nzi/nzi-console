import { createMessageTemplate } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Word a message in the organisation's own terms (admin F1) — admin.templates; a key from the code registry only, declared tokens only. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "message_template.create");
    const body = await request.json() as CommandInputMap["message_template.create"];
    return commandSuccess(await createMessageTemplate(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
