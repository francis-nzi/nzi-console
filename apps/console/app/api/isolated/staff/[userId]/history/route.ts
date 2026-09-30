import { readStaffHistory, requireCapability, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** One member's audit history, for the Team drawer — admin.users. Payloads carry ids and states only. */
export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const principal = await currentStaff(request);
    requireCapability(principal, "admin.users");
    const { userId } = await params;
    const history = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readStaffHistory(db, decodeURIComponent(userId)));
    return Response.json({ history }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
