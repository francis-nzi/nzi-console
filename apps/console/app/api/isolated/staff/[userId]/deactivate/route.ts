import { deactivateStaff } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Deactivate a member (admin Phase B) — never deleted; a reason is required; never yourself, never the last active admin. */
export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "staff.deactivate");
    const { userId } = await params;
    const body = await request.json() as Omit<CommandInputMap["staff.deactivate"], "userId">;
    return commandSuccess(await deactivateStaff(isolatedPool(), { ...body, userId: decodeURIComponent(userId) } as CommandInputMap["staff.deactivate"], commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
