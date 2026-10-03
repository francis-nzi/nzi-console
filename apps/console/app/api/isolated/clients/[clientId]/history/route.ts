import { CLIENT_HISTORY_LIMIT, clientHistoryFor, withTenantRead } from "@nzi/isolated-backend";
import { authFailure } from "../../../../../lib/authResponse";
import { isolatedPool } from "../../../../../lib/isolatedDatabase";
import { currentStaff } from "../../../../../lib/staffSession";

export const dynamic = "force-dynamic";

/**
 * One client's audit history (CLIENT-12), under audit.view: 403 without it, or for an own_clients holder on a client
 * they do not own; 404 for a client not in this organisation.
 */
export async function GET(request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const principal = await currentStaff(request);
    const { clientId } = await params;
    const history = await withTenantRead(isolatedPool(), principal.organisationId, (db) => clientHistoryFor(db, principal, clientId));
    if (history === null) return Response.json({ code: "NOT_FOUND", message: "There is no such client." }, { status: 404, headers: { "Cache-Control": "private, no-store" } });
    return Response.json({ history, limit: CLIENT_HISTORY_LIMIT }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return authFailure(error); }
}
