import { reinstateStaff } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** Reinstate a deactivated member (admin Phase B) — a reason is required; their existing sign-in works again (Q8). */
export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "staff.reinstate");
    const { userId } = await params;
    const body = await request.json() as Omit<CommandInputMap["staff.reinstate"], "userId">;
    return commandSuccess(await reinstateStaff(isolatedPool(), { ...body, userId: decodeURIComponent(userId) } as CommandInputMap["staff.reinstate"], commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
