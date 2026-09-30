import { changeStaffRole } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Change a member's role (admin Phase B) — admin.users, a reason in `x-command-reason`; never yourself, never the last active admin. */
export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "staff.role.assign");
    const { userId } = await params;
    const body = await request.json() as Omit<CommandInputMap["staff.role.assign"], "userId">;
    return commandSuccess(await changeStaffRole(isolatedPool(), { ...body, userId: decodeURIComponent(userId) } as CommandInputMap["staff.role.assign"], commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
