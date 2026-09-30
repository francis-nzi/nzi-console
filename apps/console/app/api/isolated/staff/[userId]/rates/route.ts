import { readStaffRates, setStaffRate, withTenantRead } from "@nzi/isolated-backend";
import { todayInLondon, type CommandInputMap } from "@nzi/contracts";
import { authFailure } from "../../../../../lib/authResponse";
import { requireCommandPrincipal } from "../../../../../lib/commandAuth";
import { commandContext, commandFailure, commandSuccess } from "../../../../../lib/commandResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** A member's rates, with the one in force today (R9 (c)) — finance.manage only; refused, never emptied, without it. */
export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const principal = await currentStaff(request);
    const { userId } = await params;
    const rates = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readStaffRates(db, principal, decodeURIComponent(userId), todayInLondon()));
    return Response.json(rates, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}

/** A rate from a date, or a correction of one (a reason required) — append-only, finance.manage. */
export async function POST(request: Request, { params }: { params: Promise<{ userId: string }> }) {
  try {
    const principal = await requireCommandPrincipal(request, "staff.rate.set");
    const { userId } = await params;
    const body = await request.json() as Omit<CommandInputMap["staff.rate.set"], "userId">;
    return commandSuccess(await setStaffRate(isolatedPool(), { ...body, userId: decodeURIComponent(userId) }, commandContext(request, principal)));
  } catch (error) { return commandFailure(error); }
}
