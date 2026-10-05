import { setStaffCapacity } from "@nzi/isolated-backend";
import type { CommandInputMap } from "@nzi/contracts";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

/** A person's weekly capacity (Time PR B, T-Q4) — admin.users, through the command runner. */
export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "staff.capacity.set");
    const { userId } = await params;
    const body = await request.json() as Omit<CommandInputMap["staff.capacity.set"], "userId">;
    return commandSuccess(await setStaffCapacity(isolatedPool(), { ...body, userId: decodeURIComponent(userId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
