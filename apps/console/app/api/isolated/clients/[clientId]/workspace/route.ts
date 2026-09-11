import { getClientWorkspace, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// NZC-005 / NZC-070 — one client's record, its sites, and figures resolved from its
// own reviewed snapshots. 404 for an unknown client, so the page can say so.
export async function GET(_request: Request, { params }: { params: Promise<{ clientId: string }> }) {
  try {
    const { clientId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    const workspace = await withTenantRead(pool, organisationId, (db) => getClientWorkspace(db, clientId));
    if (!workspace) return Response.json({ type: "about:blank", title: "Client not found", status: 404 }, { status: 404 });
    return Response.json(workspace);
  } catch (error) {
    return apiFailure(error);
  }
}
