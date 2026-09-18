import { listInputSpec, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// The governed input spec (NZC-102), read under the request's tenant context. The spec itself is
// global — the GHG taxonomy is the same for everyone — but it is served through the same tenant
// boundary as everything else, so the per-client visibility toggle and label overrides resolve
// here when they arrive, rather than needing a second endpoint.
export async function GET() {
  try {
    const { pool, organisationId } = requireIsolatedApiContext();
    const spec = await withTenantRead(pool, organisationId, (db) => listInputSpec(db));
    return Response.json({ spec }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return apiFailure(error);
  }
}
