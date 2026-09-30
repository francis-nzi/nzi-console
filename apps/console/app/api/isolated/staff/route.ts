import { addStaff } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../lib/commandResponse";
import { isolatedPool } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Add a member of staff (admin Phase B, Q6) — admin.users; created at the least-privilege role, sealed as written. */
export async function POST(request: Request) {
  try {
    const principal = await requireCommandPrincipal(request, "staff.add");
    const body = await request.json() as CommandInputMap["staff.add"];
    return commandSuccess(await addStaff(isolatedPool(), body, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
