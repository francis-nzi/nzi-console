import { updateStaff } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../lib/commandResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Edit a member's name and position (admin Phase B) — versioned, admin.users. The email is read-only (Q6). */
export async function PATCH(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "staff.update");
    const { userId } = await params;
    const body = await request.json() as Omit<CommandInputMap["staff.update"], "userId">;
    return commandSuccess(await updateStaff(isolatedPool(), { ...body, userId: decodeURIComponent(userId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
