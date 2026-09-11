import { getLogoAsset, logoResponse, withTenantRead } from "@nzi/isolated-backend";
import { apiFailure, requireIsolatedApiContext } from "../../../../lib/isolatedDatabase";

export const dynamic = "force-dynamic";

// A report version's frozen logo (assets are append-only, so a published report keeps its logo).
export async function GET(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const { assetId } = await params;
    const { pool, organisationId } = requireIsolatedApiContext();
    return logoResponse(await withTenantRead(pool, organisationId, (db) => getLogoAsset(db, assetId)), request.headers.get("if-none-match"));
  } catch (error) { return apiFailure(error); }
}
