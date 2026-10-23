import { authFailure } from "./authResponse";
import { currentStaff } from "./staffSession";
import { PortalDataOffError, portalDataOff } from "./portalCommand";
import type { StaffPrincipal } from "@nzi/isolated-backend";

/**
 * The staff portal preview's job-level routes (BUILD-staff-portal-preview-job-aware, R2): each mirrors one client portal GET at
 * `/api/isolated/clients/{clientId}/portal-preview/…`, so the client's own components read them unchanged but for the base.
 * The staff session, never a portal one; the backend's staff-preview authorizer decides; uncached, as the client's are. GET only —
 * there is no write anywhere under the preview (R5).
 */
export async function portalPreviewGet(request: Request, read: (principal: StaffPrincipal) => Promise<Response>): Promise<Response> {
  try {
    return await read(await currentStaff(request));
  } catch (error) {
    if (error instanceof PortalDataOffError) return portalDataOff();
    return authFailure(error);
  }
}

export const previewJson = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
