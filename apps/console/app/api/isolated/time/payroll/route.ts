import { readTimePayroll, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../lib/authResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";
import { timePeriodFrom } from "../../../../lib/timePeriodParam";

export const dynamic = "force-dynamic";

/** Payroll (Time PR B): each person's hours over the period — time.view across all clients; cost for finance.view only. */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    const parsed = timePeriodFrom(new URL(request.url));
    if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
    const payroll = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readTimePayroll(db, principal, parsed.period));
    return Response.json({ payroll }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
