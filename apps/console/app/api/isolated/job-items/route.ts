import { createJobItem } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a catalogue item (admin E2) — admin.lookups; its code is set here and never again. No amounts: those are job_item.price.set. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "job_item.create");
    const body = await request.json() as CommandInputMap["job_item.create"];
    return commandSuccess(await createJobItem(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
