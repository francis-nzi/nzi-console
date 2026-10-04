import { readLoggableJobs, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../lib/authResponse";
import { isolatedPool } from "../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/** The jobs the caller can log time against (T-Q7): own clients' under own_clients, any under all; never cancelled. */
export async function GET(request: Request) {
  try {
    const principal = await currentStaff(request);
    const jobs = await withTenantRead(isolatedPool(), principal.organisationId, (db) => readLoggableJobs(db, principal));
    return Response.json({ jobs }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
